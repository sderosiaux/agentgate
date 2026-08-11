import { assertMasterKey } from './crypto.js';

/**
 * Environment the gateway cannot run without. Credentials are stored encrypted, so a missing
 * or malformed master key means every proxied request would fail at injection time: better to
 * refuse to start than to serve a gateway that cannot use any credential.
 */
export function assertBootEnv(env: NodeJS.ProcessEnv = process.env): void {
  assertMasterKey(env['AGENTGATE_MASTER_KEY']);
}
