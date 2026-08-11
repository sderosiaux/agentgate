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
  policyEngine: PolicyEngineName;
  opaUrl: string | undefined;
  environment: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];

  if (value === undefined || value === '') {
    throw new Error(`${name} is not set: the gateway cannot start without it`);
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
    policyEngine,
    ...(opaUrl === undefined || opaUrl === '' ? { opaUrl: undefined } : { opaUrl }),
    environment: env['ENVIRONMENT'] ?? 'development',
  };
}
