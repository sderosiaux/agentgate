import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { assertBootEnv } from '../src/secrets/index.js';

const run = promisify(execFile);
const gatewayRoot = path.resolve(import.meta.dirname, '..');

const VALID_KEY = Buffer.alloc(32, 0x11).toString('base64');

test('a valid master key lets the gateway boot', () => {
  expect(() => assertBootEnv({ AGENTGATE_MASTER_KEY: VALID_KEY })).not.toThrow();
});

test('the ambient environment is usable, so the demo stack boots', () => {
  expect(() => assertBootEnv()).not.toThrow();
});

test('a missing master key stops the boot', () => {
  expect(() => assertBootEnv({})).toThrow(/AGENTGATE_MASTER_KEY/);
});

test('a malformed master key stops the boot', () => {
  expect(() => assertBootEnv({ AGENTGATE_MASTER_KEY: 'too-short' })).toThrow(
    /AGENTGATE_MASTER_KEY/,
  );
  expect(() =>
    assertBootEnv({ AGENTGATE_MASTER_KEY: Buffer.alloc(16).toString('base64') }),
  ).toThrow(/32 bytes/);
});

test('the process exits non-zero, before listening, when the master key is unusable', async () => {
  const env = { ...process.env, AGENTGATE_MASTER_KEY: 'not-a-key', PORT: '0' };

  const outcome = await run(path.join(gatewayRoot, 'node_modules/.bin/tsx'), ['src/index.ts'], {
    cwd: gatewayRoot,
    env,
    timeout: 30_000,
  }).then(
    // Reaching here means the process stayed up and was killed by the timeout instead.
    () => ({ exitCode: 0, stderr: '' }),
    (error: { code?: number; stderr?: string }) => ({
      exitCode: error.code ?? 0,
      stderr: error.stderr ?? '',
    }),
  );

  expect(outcome.exitCode).toBe(1);
  expect(outcome.stderr).toMatch(/AGENTGATE_MASTER_KEY/);
  expect(outcome.stderr).not.toContain('not-a-key');
}, 40_000);
