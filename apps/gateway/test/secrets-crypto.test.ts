import { describe, expect, test } from 'vitest';
import { assertMasterKey, decryptSecret, encryptSecret } from '../src/secrets/crypto.js';

const KEY = Buffer.alloc(32, 0x07).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 0x09).toString('base64');

const IV_BYTES = 12;
const TAG_BYTES = 16;

function tamper(blob: Buffer, offset: number): Buffer {
  const copy = Buffer.from(blob);
  copy.writeUInt8(copy.readUInt8(offset) ^ 0xff, offset);
  return copy;
}

describe('encryptSecret / decryptSecret', () => {
  test('a secret survives a roundtrip', () => {
    const blob = encryptSecret(KEY, 'fixture-token-do-not-log');

    expect(decryptSecret(KEY, blob)).toBe('fixture-token-do-not-log');
  });

  test('the roundtrip preserves multi-byte characters and empty values', () => {
    for (const plaintext of ['clé-é&$€ 🔐', '']) {
      expect(decryptSecret(KEY, encryptSecret(KEY, plaintext))).toBe(plaintext);
    }
  });

  test('the blob is laid out as iv || tag || ciphertext', () => {
    const plaintext = 'token';

    const blob = encryptSecret(KEY, plaintext);

    // GCM is a stream mode: the ciphertext is exactly as long as the plaintext.
    expect(blob).toHaveLength(IV_BYTES + TAG_BYTES + Buffer.byteLength(plaintext, 'utf8'));
  });

  test('the ciphertext never contains the plaintext', () => {
    const blob = encryptSecret(KEY, 'fixture-token-do-not-log');

    expect(blob.toString('utf8')).not.toContain('fixture-token');
    expect(blob.toString('latin1')).not.toContain('fixture-token');
  });

  test('encrypting the same secret twice gives different blobs', () => {
    const first = encryptSecret(KEY, 'same-token');
    const second = encryptSecret(KEY, 'same-token');

    expect(first.equals(second)).toBe(false);
    expect(first.subarray(0, IV_BYTES).equals(second.subarray(0, IV_BYTES))).toBe(false);
    expect(decryptSecret(KEY, first)).toBe(decryptSecret(KEY, second));
  });

  test('decrypting with the wrong key throws', () => {
    const blob = encryptSecret(KEY, 'fixture-token-do-not-log');

    expect(() => decryptSecret(OTHER_KEY, blob)).toThrow(/could not be decrypted/i);
  });

  test('a flipped ciphertext byte throws', () => {
    const blob = encryptSecret(KEY, 'fixture-token-do-not-log');

    expect(() => decryptSecret(KEY, tamper(blob, IV_BYTES + TAG_BYTES))).toThrow(
      /could not be decrypted/i,
    );
  });

  test('a flipped authentication tag byte throws', () => {
    const blob = encryptSecret(KEY, 'fixture-token-do-not-log');

    expect(() => decryptSecret(KEY, tamper(blob, IV_BYTES))).toThrow(/could not be decrypted/i);
  });

  test('a flipped iv byte throws', () => {
    const blob = encryptSecret(KEY, 'fixture-token-do-not-log');

    expect(() => decryptSecret(KEY, tamper(blob, 0))).toThrow(/could not be decrypted/i);
  });

  test('a truncated blob throws instead of decrypting garbage', () => {
    const blob = encryptSecret(KEY, 'fixture-token-do-not-log');

    expect(() => decryptSecret(KEY, blob.subarray(0, IV_BYTES + TAG_BYTES - 1))).toThrow(
      /too short/i,
    );
  });

  test('the failure never echoes the secret material', () => {
    const blob = encryptSecret(KEY, 'fixture-token-do-not-log');

    expect(() => decryptSecret(OTHER_KEY, blob)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(OTHER_KEY) }),
    );
  });
});

describe('assertMasterKey', () => {
  test('accepts a 32-byte base64 key', () => {
    expect(() => assertMasterKey(KEY)).not.toThrow();
  });

  test('rejects an absent key', () => {
    expect(() => assertMasterKey(undefined)).toThrow(/AGENTGATE_MASTER_KEY/);
    expect(() => assertMasterKey('')).toThrow(/AGENTGATE_MASTER_KEY/);
  });

  test('rejects a key that is not 32 bytes', () => {
    expect(() => assertMasterKey(Buffer.alloc(16, 1).toString('base64'))).toThrow(/32 bytes/);
    expect(() => assertMasterKey(Buffer.alloc(64, 1).toString('base64'))).toThrow(/32 bytes/);
  });

  test('rejects a value that is not base64', () => {
    expect(() => assertMasterKey('not a base64 key at all')).toThrow(/base64/);
    // Buffer.from ignores characters outside the alphabet: trailing junk would otherwise
    // decode to a valid 32-byte key.
    expect(() => assertMasterKey(`${KEY}!!!!`)).toThrow(/base64/);
  });

  test('the failure never echoes the key material', () => {
    const almost = Buffer.alloc(16, 1).toString('base64');

    expect(() => assertMasterKey(almost)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(almost) }),
    );
  });
});
