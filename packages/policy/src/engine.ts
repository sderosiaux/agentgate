import type { PolicyDecision } from '@agentgate/shared';
import { actionImplied } from './actions.js';
import { parsePolicyInput, type PolicyEngine, type PolicyInput } from './types.js';

function covers(grants: readonly string[], requested: string): boolean {
  return grants.some((granted) => actionImplied(granted, requested));
}

/**
 * SPEC D3 steps 6 to 10, and nothing else. Token validity, mission expiry, limits and network
 * rules (steps 1 to 5) are the gateway pipeline's job and have already run by the time this
 * is called — duplicating them here would mean two places to get them wrong.
 *
 * The order below is the decision: an action listed in several places resolves to the first
 * list that speaks about it, which is why `approval_required` ⊂ `allowed_actions` gates rather
 * than allows.
 */
function decide(input: PolicyInput): PolicyDecision {
  const { permissions } = input.mission;
  const resource = `${input.resource.provider}:${input.resource.id}`;
  const action = input.action.type;

  if (!permissions.resources.includes(resource)) {
    return {
      decision: 'DENY',
      reason: `resource ${resource} is not in the mission scope`,
      matchedPolicy: 'mission-resource-scope',
    };
  }

  if (covers(permissions.deniedActions, action)) {
    return {
      decision: 'DENY',
      reason: `action ${action} is denied by the mission`,
      matchedPolicy: 'mission-denied-action',
    };
  }

  if (covers(permissions.approvalActions, action)) {
    return {
      decision: 'REQUIRE_APPROVAL',
      reason: `action ${action} requires an approval`,
      matchedPolicy: 'mission-approval-required',
    };
  }

  if (covers(permissions.allowedActions, action)) {
    return {
      decision: 'ALLOW',
      reason: `action ${action} is allowed by the mission`,
      matchedPolicy: 'mission-allowed-action',
    };
  }

  return {
    decision: 'DENY',
    reason: `action ${action} is not granted by the mission`,
    matchedPolicy: 'mission-default-deny',
  };
}

export function createBuiltinEngine(): PolicyEngine {
  return {
    // `async` so a malformed input rejects the promise instead of throwing at the call site:
    // callers handle one failure channel, not two.
    async evaluate(input: PolicyInput): Promise<PolicyDecision> {
      return decide(parsePolicyInput(input));
    },
  };
}
