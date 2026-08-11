import { assertBootEnv } from './secrets/index.js';

export type PolicyEngineName = 'builtin' | 'opa';

export interface GatewayConfig {
  port: number;
  host: string;
  databaseUrl: string;
  masterKey: string;
  /** Verification key. A gateway that cannot verify a token cannot enforce anything. */
  jwtPublicKey: string;
  /** Signing key. Absent on a gateway that only verifies — minting is management (plan 08). */
  jwtPrivateKey: string | undefined;
  /** The single credential guarding the management API, including approve and deny. */
  adminToken: string;
  policyEngine: PolicyEngineName;
  opaUrl: string | undefined;
  environment: string;
}

/**
 * The shortest admin token the gateway will start with.
 *
 * Not a guess at entropy: the log scrubber ignores any registered value shorter than
 * `MIN_SENSITIVE_LENGTH` (8), because scrubbing ordinary words out of every line would destroy
 * more than it protects. A six-character admin token would therefore be a credential that can
 * never be redacted — it would pass through any line that happened to carry it. Sixteen sits
 * clear of that floor and is unremarkable for a bearer token nobody has to type twice.
 */
export const ADMIN_TOKEN_MIN_LENGTH = 16;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];

  if (value === undefined || value === '') {
    throw new Error(`${name} is not set: the gateway cannot start without it`);
  }

  return value;
}

/** The value is never echoed: a refusal that quotes the token writes it to a console log. */
function adminToken(env: NodeJS.ProcessEnv): string {
  const value = required(env, 'ADMIN_TOKEN');

  if (value.length < ADMIN_TOKEN_MIN_LENGTH) {
    throw new Error(
      `ADMIN_TOKEN must be at least ${String(ADMIN_TOKEN_MIN_LENGTH)} characters: a shorter one cannot be redacted from the logs`,
    );
  }

  return value;
}

/**
 * Everything the gateway reads from its environment, read once, at boot, before anything is
 * built or bound.
 *
 * A gateway missing its master key cannot decrypt a credential and one missing its public key
 * cannot verify a token: either way every request it accepts would fail, so refusing to start
 * is both cheaper to diagnose and the only honest answer. Values are never echoed in the
 * failures — the names are what an operator needs.
 */
export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  assertBootEnv(env);

  const policyEngine = env['POLICY_ENGINE'] ?? 'builtin';
  if (policyEngine !== 'builtin' && policyEngine !== 'opa') {
    throw new Error(`POLICY_ENGINE must be "builtin" or "opa", not "${policyEngine}"`);
  }

  const opaUrl = env['OPA_URL'];
  if (policyEngine === 'opa' && (opaUrl === undefined || opaUrl === '')) {
    throw new Error('OPA_URL is not set: POLICY_ENGINE=opa has nothing to ask');
  }

  const port = Number(env['PORT'] ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`PORT must be a tcp port number, not "${String(env['PORT'])}"`);
  }

  return {
    port,
    host: env['HOST'] ?? '0.0.0.0',
    databaseUrl: required(env, 'DATABASE_URL'),
    masterKey: required(env, 'AGENTGATE_MASTER_KEY'),
    jwtPublicKey: required(env, 'AGENTGATE_JWT_PUBLIC_KEY'),
    jwtPrivateKey: env['AGENTGATE_JWT_PRIVATE_KEY'],
    // Not optional, and not defaulted: a gateway that started with an empty admin token would
    // serve the management API to anyone who sends an empty bearer, which is worse than a
    // gateway that refuses to start.
    adminToken: adminToken(env),
    policyEngine,
    ...(opaUrl === undefined || opaUrl === '' ? { opaUrl: undefined } : { opaUrl }),
    environment: env['ENVIRONMENT'] ?? 'development',
  };
}
