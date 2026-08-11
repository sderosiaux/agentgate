import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// AES-256-GCM with a random 96-bit IV per secret, the layout stored in `Credential.ciphertext`:
//
//   iv (12 bytes) || auth tag (16 bytes) || ciphertext (as long as the plaintext)
//
// The IV goes first because it is fixed-width and unauthenticated by construction; GCM
// still binds it to the tag, so flipping any byte of the blob fails the integrity check.
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Validates the master key without ever putting its material in an error message.
 * Throws unless the value decodes from base64 to exactly 32 bytes.
 */
export function assertMasterKey(masterKeyB64: string | undefined): asserts masterKeyB64 is string {
  if (!masterKeyB64) {
    throw new Error('AGENTGATE_MASTER_KEY is not set (expected 32 bytes, base64-encoded)');
  }

  const decoded = Buffer.from(masterKeyB64, 'base64');

  // `Buffer.from` silently drops characters outside the base64 alphabet, so a corrupted
  // value can still decode to 32 plausible bytes. Re-encoding is what catches it.
  if (decoded.toString('base64') !== masterKeyB64) {
    throw new Error('AGENTGATE_MASTER_KEY is not valid base64 (expected 32 bytes, base64-encoded)');
  }

  if (decoded.length !== KEY_BYTES) {
    throw new Error(
      `AGENTGATE_MASTER_KEY must decode to 32 bytes, got ${String(decoded.length)} bytes`,
    );
  }
}

function masterKey(masterKeyB64: string): Buffer {
  assertMasterKey(masterKeyB64);
  return Buffer.from(masterKeyB64, 'base64');
}

export function encryptSecret(masterKeyB64: string, plaintext: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey(masterKeyB64), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptSecret(masterKeyB64: string, blob: Buffer): string {
  if (blob.length < IV_BYTES + TAG_BYTES) {
    throw new Error(
      `Stored secret is too short to be an AES-256-GCM blob (${String(blob.length)} bytes)`,
    );
  }

  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, masterKey(masterKeyB64), iv);
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (error) {
    // Wrong key or tampered blob — indistinguishable by design, and the underlying message
    // is kept as a cause rather than surfaced.
    throw new Error('Stored secret could not be decrypted (wrong master key or tampered data)', {
      cause: error,
    });
  }
}
