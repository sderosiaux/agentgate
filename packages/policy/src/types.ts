import type { MissionPermissions, NetworkRules } from '@agentgate/shared';
import type { PolicyDecision } from '@agentgate/shared';

/**
 * Everything an engine is allowed to look at, and nothing else: the same document is handed
 * to the builtin evaluator and serialised as-is to OPA, so the two can never drift apart on
 * the shape of the question they are asked.
 */
export interface PolicyInput {
  identity: { principalId: string; agentId: string; agentType: string };
  mission: {
    id: string;
    intent: string;
    permissions: MissionPermissions;
    network: NetworkRules;
    /** ISO 8601. Expiry is enforced by the gateway pipeline (D3 step 2), not by the engine. */
    expiresAt: string;
  };
  /** `provider` + `id` form the mission scope key, e.g. `github` + `acme/payments`. */
  resource: { provider: string; id: string };
  /** Produced by a {@link ProviderAdapter}, never by the agent. */
  action: { type: string; method: string };
  /** Already normalised by `normalizeUrl`. */
  network: { host: string; path: string };
  environment: { name: string };
  currentState: { requestCount: number; bytesTotal: number };
  data: { contentType?: string; bodySize?: number; bodyHash?: string };
}

export interface PolicyEngine {
  evaluate(input: PolicyInput): Promise<PolicyDecision>;
}
