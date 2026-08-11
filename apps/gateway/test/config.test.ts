import { expect, test } from 'vitest';
import { ADMIN_TOKEN_MIN_LENGTH, loadGatewayConfig } from '../src/config.js';
import { MIN_SENSITIVE_LENGTH } from '../src/logging.js';

const VALID: NodeJS.ProcessEnv = {
  AGENTGATE_MASTER_KEY: Buffer.alloc(32, 0x11).toString('base64'),
  AGENTGATE_JWT_PUBLIC_KEY: 'MCowBQYDK2VwAyEA+PGqiz7+4VXQkMd1WL/BfPxi9FJxG8bgUYzl5ysYXQ8=',
  DATABASE_URL: 'postgresql://agentgate:agentgate@postgres:5432/agentgate',
  ADMIN_TOKEN: 'admin-token-for-the-test',
};

test('the demo environment is usable, so the stack boots', () => {
  expect(() => loadGatewayConfig()).not.toThrow();
});

test('a complete environment yields the defaults the demo runs on', () => {
  const config = loadGatewayConfig(VALID);

  expect(config).toMatchObject({
    port: 8080,
    host: '0.0.0.0',
    policyEngine: 'builtin',
    environment: 'development',
    opaUrl: undefined,
  });
});

test('a gateway that cannot verify a token refuses to start', () => {
  const { AGENTGATE_JWT_PUBLIC_KEY: _omitted, ...withoutPublicKey } = VALID;

  expect(() => loadGatewayConfig(withoutPublicKey)).toThrow(/AGENTGATE_JWT_PUBLIC_KEY/);
});

test('a gateway that cannot decrypt a credential refuses to start', () => {
  expect(() => loadGatewayConfig({ ...VALID, AGENTGATE_MASTER_KEY: 'nope' })).toThrow(
    /AGENTGATE_MASTER_KEY/,
  );
});

test('a gateway with no database refuses to start', () => {
  const { DATABASE_URL: _omitted, ...withoutDatabase } = VALID;

  expect(() => loadGatewayConfig(withoutDatabase)).toThrow(/DATABASE_URL/);
});

test('a gateway with no admin token refuses to start', () => {
  const { ADMIN_TOKEN: _omitted, ...withoutAdminToken } = VALID;

  // An empty one is the dangerous case: the guard would then accept an empty bearer.
  expect(() => loadGatewayConfig(withoutAdminToken)).toThrow(/ADMIN_TOKEN/);
  expect(() => loadGatewayConfig({ ...VALID, ADMIN_TOKEN: '' })).toThrow(/ADMIN_TOKEN/);
});

test('an admin token the log scrubber would ignore refuses to start', () => {
  // Anything shorter than the scrubber's own threshold could never be redacted from a log
  // line, so the bound the config enforces has to sit above it.
  expect(ADMIN_TOKEN_MIN_LENGTH).toBeGreaterThanOrEqual(MIN_SENSITIVE_LENGTH);

  expect(() => loadGatewayConfig({ ...VALID, ADMIN_TOKEN: 'hunter2' })).toThrow(
    new RegExp(`ADMIN_TOKEN.*${String(ADMIN_TOKEN_MIN_LENGTH)}`),
  );
  expect(() =>
    loadGatewayConfig({ ...VALID, ADMIN_TOKEN: 'a'.repeat(ADMIN_TOKEN_MIN_LENGTH) }),
  ).not.toThrow();
});

test('the refusal names the constraint without quoting the token back', () => {
  const tooShort = 'sekret42';

  expect(() => loadGatewayConfig({ ...VALID, ADMIN_TOKEN: tooShort })).toThrow(
    expect.objectContaining({ message: expect.not.stringContaining(tooShort) }),
  );
});

test('the signing key stays optional: a gateway that only verifies is a valid one', () => {
  const config = loadGatewayConfig(VALID);

  expect(config.jwtPrivateKey).toBeUndefined();
});

test('an unknown policy engine is refused rather than quietly ignored', () => {
  expect(() => loadGatewayConfig({ ...VALID, POLICY_ENGINE: 'rego-ish' })).toThrow(/POLICY_ENGINE/);
});

test('choosing OPA without telling the gateway where it is refuses to start', () => {
  expect(() => loadGatewayConfig({ ...VALID, POLICY_ENGINE: 'opa' })).toThrow(/OPA_URL/);
});

test('choosing OPA with an address is accepted', () => {
  const config = loadGatewayConfig({
    ...VALID,
    POLICY_ENGINE: 'opa',
    OPA_URL: 'http://opa:8181',
  });

  expect(config).toMatchObject({ policyEngine: 'opa', opaUrl: 'http://opa:8181' });
});

test('a port that is not one refuses to start', () => {
  expect(() => loadGatewayConfig({ ...VALID, PORT: 'eighty' })).toThrow(/PORT/);
  expect(() => loadGatewayConfig({ ...VALID, PORT: '70000' })).toThrow(/PORT/);
});

test('no failure ever echoes the value it refused', () => {
  const failure = (() => {
    try {
      loadGatewayConfig({ ...VALID, AGENTGATE_MASTER_KEY: 'a-secret-looking-value' });
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  })();

  expect(failure).not.toContain('a-secret-looking-value');
});
