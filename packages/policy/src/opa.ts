import { AgentGateError, DECISIONS, type PolicyDecision } from '@agentgate/shared';
import { z } from 'zod';
import type { PolicyEngine, PolicyInput } from './types.js';

/** A policy call sits on the request path: a hung OPA must fail the request, not hold it. */
const TIMEOUT_MS = 2_000;

const ResponseSchema = z.object({
  // Absent when the policy is missing or its rule is undefined — never a silent allow.
  result: z.object({
    decision: z.enum(DECISIONS),
    reason: z.string(),
    matchedPolicy: z.string().optional(),
  }),
});

function unusable(reason: string, cause?: unknown): AgentGateError {
  return new AgentGateError('agentgate_upstream_error', 502, reason, { cause });
}

/**
 * Evaluates `policies/agentgate.rego` in an OPA server. Same input, same output, same
 * semantics as {@link createBuiltinEngine} — selected with `POLICY_ENGINE=opa`.
 */
export function createOpaEngine(opaUrl: string): PolicyEngine {
  const endpoint = `${opaUrl.replace(/\/+$/, '')}/v1/data/agentgate/decision`;

  return {
    async evaluate(input: PolicyInput): Promise<PolicyDecision> {
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        throw unusable('policy engine is unreachable', error);
      }

      if (!response.ok) {
        throw unusable(`policy engine answered with status ${response.status}`);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        throw unusable('policy engine answered with a body that is not json', error);
      }

      const parsed = ResponseSchema.safeParse(body);
      if (!parsed.success) {
        throw unusable('policy engine answered with no usable decision', parsed.error);
      }

      const { decision, reason, matchedPolicy } = parsed.data.result;
      return {
        decision,
        reason,
        ...(matchedPolicy === undefined ? {} : { matchedPolicy }),
      };
    },
  };
}
