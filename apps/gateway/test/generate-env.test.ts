import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { importPKCS8, importSPKI } from 'jose';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
let env: Record<string, string>;
let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'agentgate-env-'));
  const outputPath = path.join(workDir, '.env');

  execFileSync('node', [path.join(repoRoot, 'scripts/generate-env.mjs'), outputPath], {
    stdio: 'pipe',
  });

  env = Object.fromEntries(
    readFileSync(outputPath, 'utf8')
      .split('\n')
      .filter((line) => line.includes('=') && !line.startsWith('#'))
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

test('the generated master key decodes to 32 bytes', () => {
  const masterKey = env['AGENTGATE_MASTER_KEY'];

  expect(masterKey).toBeDefined();
  expect(Buffer.from(masterKey!, 'base64')).toHaveLength(32);
});

test('the generated JWT keypair imports as Ed25519', async () => {
  const toPem = (der: string, label: string) =>
    `-----BEGIN ${label}-----\n${der.replace(/(.{64})/g, '$1\n')}\n-----END ${label}-----`;

  await expect(
    importPKCS8(toPem(env['AGENTGATE_JWT_PRIVATE_KEY']!, 'PRIVATE KEY'), 'EdDSA'),
  ).resolves.toBeDefined();
  await expect(
    importSPKI(toPem(env['AGENTGATE_JWT_PUBLIC_KEY']!, 'PUBLIC KEY'), 'EdDSA'),
  ).resolves.toBeDefined();
});

test('the generated secrets differ from the committed dev-only values', () => {
  const template = readFileSync(path.join(repoRoot, '.env.example'), 'utf8');

  for (const key of [
    'AGENTGATE_MASTER_KEY',
    'AGENTGATE_JWT_PRIVATE_KEY',
    'AGENTGATE_JWT_PUBLIC_KEY',
    // The management API can approve anything the policy engine gates: a generated
    // environment that kept `dev-admin-token` would hand that away with the repository.
    'ADMIN_TOKEN',
  ]) {
    expect(template).not.toContain(`${key}=${env[key]}`);
  }
});

test('non-secret settings are carried over from the template', () => {
  expect(env['DATABASE_URL']).toBe('postgresql://agentgate:agentgate@postgres:5432/agentgate');
  expect(env['POLICY_ENGINE']).toBe('builtin');
});
