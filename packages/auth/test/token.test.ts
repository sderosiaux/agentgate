import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SignJWT, decodeJwt, exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import { AgentGateError } from '@agentgate/shared';
import { beforeAll, expect, test } from 'vitest';
import { createTokenService, type AgentClaims, type TokenService } from '../src/token.js';

const claims: AgentClaims = {
  agentId: 'agt_demo',
  principalId: 'pri_stephane',
  agentType: 'codex',
  missionId: 'mis_demo',
  sessionId: 'ses_0123456789abcdef0123',
};

interface Keypair {
  privateKey: CryptoKey;
  privateKeyB64: string;
  publicKeyB64: string;
}

function derFromPem(pem: string): string {
  return pem
    .split('\n')
    .filter((line) => !line.startsWith('-----'))
    .join('');
}

async function newKeypair(): Promise<Keypair> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { extractable: true });

  return {
    privateKey,
    privateKeyB64: derFromPem(await exportPKCS8(privateKey)),
    publicKeyB64: derFromPem(await exportSPKI(publicKey)),
  };
}

function inOneHour(): Date {
  return new Date(Date.now() + 60 * 60 * 1000);
}

let keys: Keypair;
let tokens: TokenService;

beforeAll(async () => {
  keys = await newKeypair();
  tokens = createTokenService(keys.privateKeyB64, keys.publicKeyB64);
});

test('a minted token verifies back into the exact same claims', async () => {
  const token = await tokens.mint(claims, inOneHour());

  await expect(tokens.verify(token)).resolves.toEqual(claims);
});

test('the payload uses the claim names of the spec', async () => {
  const token = await tokens.mint(claims, inOneHour());

  expect(decodeJwt(token)).toMatchObject({
    sub: 'agt_demo',
    principal_id: 'pri_stephane',
    agent_type: 'codex',
    mission_id: 'mis_demo',
    session_id: 'ses_0123456789abcdef0123',
    iat: expect.any(Number),
    exp: expect.any(Number),
  });
});

test('exp follows the requested expiry to the second', async () => {
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  const token = await tokens.mint(claims, expiresAt);

  expect(decodeJwt(token).exp).toBe(Math.floor(expiresAt.getTime() / 1000));
});

test('an expired token is rejected', async () => {
  const token = await tokens.mint(claims, new Date(Date.now() - 1000));

  await expect(tokens.verify(token)).rejects.toBeInstanceOf(AgentGateError);
  await expect(tokens.verify(token)).rejects.toMatchObject({
    code: 'agentgate_invalid_token',
    httpStatus: 401,
  });
});

test('a tampered payload is rejected', async () => {
  const token = await tokens.mint(claims, inOneHour());
  const [header, payload, signature] = token.split('.') as [string, string, string];
  const forged = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
  forged['mission_id'] = 'mis_someone_else';
  const tampered = [
    header,
    Buffer.from(JSON.stringify(forged), 'utf8').toString('base64url'),
    signature,
  ].join('.');

  await expect(tokens.verify(tampered)).rejects.toMatchObject({
    code: 'agentgate_invalid_token',
  });
});

test('a token signed by another keypair is rejected', async () => {
  const attacker = await newKeypair();
  const attackerTokens = createTokenService(attacker.privateKeyB64, attacker.publicKeyB64);

  const token = await attackerTokens.mint(claims, inOneHour());

  await expect(tokens.verify(token)).rejects.toMatchObject({
    code: 'agentgate_invalid_token',
  });
});

test('a correctly signed token missing a claim is rejected', async () => {
  const incomplete = await new SignJWT({
    principal_id: claims.principalId,
    agent_type: claims.agentType,
    mission_id: claims.missionId,
    // session_id deliberately absent
  })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(claims.agentId)
    .setIssuedAt()
    .setExpirationTime(inOneHour())
    .sign(keys.privateKey);

  await expect(tokens.verify(incomplete)).rejects.toMatchObject({
    code: 'agentgate_invalid_token',
  });
});

test('garbage is rejected', async () => {
  for (const junk of ['', 'not-a-jwt', 'a.b.c']) {
    await expect(tokens.verify(junk)).rejects.toMatchObject({
      code: 'agentgate_invalid_token',
      httpStatus: 401,
    });
  }
});

test('minting without a private key fails loudly, verifying still works', async () => {
  const verifyOnly = createTokenService(undefined, keys.publicKeyB64);

  await expect(verifyOnly.mint(claims, inOneHour())).rejects.toThrow(/private key/i);
  await expect(verifyOnly.verify(await tokens.mint(claims, inOneHour()))).resolves.toEqual(claims);
});

test('the dev keypair committed in .env.example is usable as is', async () => {
  const envExample = readFileSync(
    path.resolve(import.meta.dirname, '../../../.env.example'),
    'utf8',
  );
  const read = (key: string): string => {
    const match = envExample.match(new RegExp(`^${key}=(.+)$`, 'm'));
    if (!match?.[1]) throw new Error(`${key} is missing from .env.example`);
    return match[1].trim();
  };

  const devTokens = createTokenService(
    read('AGENTGATE_JWT_PRIVATE_KEY'),
    read('AGENTGATE_JWT_PUBLIC_KEY'),
  );

  await expect(devTokens.verify(await devTokens.mint(claims, inOneHour()))).resolves.toEqual(
    claims,
  );
});
