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
    /** Whatever the issuer wrote on this mission. Not the deployment — see `environment`. */
    label: string;
    /** ISO 8601. Expiry is enforced by the gateway pipeline (D3 step 2), not by the engine. */
    expiresAt: string;
  };
  /** `provider` + `id` form the mission scope key, e.g. `github` + `acme/payments`. */
  resource: { provider: string; id: string };
  /** Produced by a {@link ProviderAdapter}, never by the agent. */
  action: { type: string; method: string };
  /**
   * Which key the request asked to be signed with, by name.
   *
   * A name, never material: the alias is the same string an operator types into the management
   * API, and the value behind it is not resolved until after this decision. Optional because a
   * `PolicyInput` built by anything other than the gateway pipeline — a test, a replay of a
   * stored snapshot — may not have one, and a policy that cares should say so itself rather
   * than inherit an invented default.
   *
   * The gateway already refuses an alias the mission does not list (D2) before it gets here, so
   * a rule reading this field is narrowing an authorisation, never widening one.
   */
  credentialAlias?: string | undefined;
  /** Already normalised by `normalizeUrl`. */
  network: { host: string; path: string };
  /**
   * Which deployment this gateway is, read from its own configuration and from nothing a caller
   * can write. A rule of the form "no deletes in production" is only worth writing if the thing
   * it reads cannot be set by whoever creates the mission.
   */
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
    label: z.string(),
    expiresAt: z.string(),
  }),
  resource: z.object({ provider: nonEmpty, id: nonEmpty }),
  action: z.object({ type: nonEmpty, method: nonEmpty }),
  // Non-empty when present, for the same reason `provider` is: an empty string is not a name,
  // it is what a missing field decays into, and a rule comparing against it would match one.
  credentialAlias: nonEmpty.optional(),
  network: z.object({ host: z.string(), path: z.string() }),
  environment: z.object({ name: z.string() }),
  currentState: z.object({
    requestCount: z.number().int().nonnegative(),
    bytesTotal: z.number().int().nonnegative(),
  }),
  data: z.object({
    contentType: z.string().optional(),
    // A byte count, held to the same shape as the counters in `currentState`.
    bodySize: z.number().int().nonnegative().optional(),
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
