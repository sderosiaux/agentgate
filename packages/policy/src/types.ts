import {
  AgentGateError,
  MissionPermissionsSchema,
  NetworkRulesSchema,
  type MissionPermissions,
  type NetworkRules,
  type PolicyDecision,
} from '@agentgate/shared';
import { z } from 'zod';

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
  data: {
    contentType?: string | undefined;
    bodySize?: number | undefined;
    bodyHash?: string | undefined;
  };
}

const nonEmpty = z.string().min(1);

/**
 * The shape both engines insist on before deciding anything.
 *
 * Neither used to check, and they failed open in opposite directions on the same malformed
 * document: a `provider` of `["github"]` stringified into a real scope key on the builtin,
 * while a missing `provider` slipped past the rego's scope check entirely. Whatever an engine
 * cannot read as a well-formed question it must refuse, rather than answer.
 *
 * `provider`, `id` and `action.type` are required non-empty: an empty string is not a name,
 * it is what a missing field decays into, and it builds a scope key of `":"`.
 */
export const PolicyInputSchema = z.object({
  identity: z.object({
    principalId: z.string(),
    agentId: z.string(),
    agentType: z.string(),
  }),
  mission: z.object({
    id: z.string(),
    intent: z.string(),
    permissions: MissionPermissionsSchema,
    network: NetworkRulesSchema,
    expiresAt: z.string(),
  }),
  resource: z.object({ provider: nonEmpty, id: nonEmpty }),
  action: z.object({ type: nonEmpty, method: nonEmpty }),
  network: z.object({ host: z.string(), path: z.string() }),
  environment: z.object({ name: z.string() }),
  currentState: z.object({
    requestCount: z.number().int().nonnegative(),
    bytesTotal: z.number().int().nonnegative(),
  }),
  data: z.object({
    contentType: z.string().optional(),
    bodySize: z.number().optional(),
    bodyHash: z.string().optional(),
  }),
});

/** Runs at the head of every `evaluate`. A refusal is not a decision, and never an ALLOW. */
export function parsePolicyInput(input: unknown): PolicyInput {
  const parsed = PolicyInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new AgentGateError('agentgate_validation_error', 400, 'policy input is not well formed', {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export interface PolicyEngine {
  evaluate(input: PolicyInput): Promise<PolicyDecision>;
}
