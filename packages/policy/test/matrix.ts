import type { MissionPermissions, PolicyDecision } from '@agentgate/shared';
import type { PolicyInput } from '../src/types.js';

export interface DecisionCase {
  name: string;
  permissions: MissionPermissions;
  resource: { provider: string; id: string };
  action: { type: string; method: string };
  expected: PolicyDecision;
}

function permissions(
  resources: string[],
  allowedActions: string[],
  approvalActions: string[],
  deniedActions: string[],
): MissionPermissions {
  return { resources, allowedActions, approvalActions, deniedActions };
}

const PAYMENTS = { provider: 'github', id: 'acme/payments' };
const SCOPE = ['github:acme/payments'];

function allow(action: string): PolicyDecision {
  return {
    decision: 'ALLOW',
    reason: `action ${action} is allowed by the mission`,
    matchedPolicy: 'mission-allowed-action',
  };
}

function denied(action: string): PolicyDecision {
  return {
    decision: 'DENY',
    reason: `action ${action} is denied by the mission`,
    matchedPolicy: 'mission-denied-action',
  };
}

function approval(action: string): PolicyDecision {
  return {
    decision: 'REQUIRE_APPROVAL',
    reason: `action ${action} requires an approval`,
    matchedPolicy: 'mission-approval-required',
  };
}

function defaultDeny(action: string): PolicyDecision {
  return {
    decision: 'DENY',
    reason: `action ${action} is not granted by the mission`,
    matchedPolicy: 'mission-default-deny',
  };
}

function outOfScope(resource: string): PolicyDecision {
  return {
    decision: 'DENY',
    reason: `resource ${resource} is not in the mission scope`,
    matchedPolicy: 'mission-resource-scope',
  };
}

/**
 * The D3 precedence table, exhaustively. Every engine implementation is held to this exact
 * list — decision, reason and matched policy — so builtin and OPA cannot drift apart.
 */
export const DECISION_MATRIX: readonly DecisionCase[] = [
  {
    name: 'an allowed action is allowed',
    permissions: permissions(SCOPE, ['repo.read'], [], []),
    resource: PAYMENTS,
    action: { type: 'repo.read', method: 'GET' },
    expected: allow('repo.read'),
  },
  {
    name: 'repo.read allows issue.read through the action hierarchy',
    permissions: permissions(SCOPE, ['repo.read'], [], []),
    resource: PAYMENTS,
    action: { type: 'issue.read', method: 'GET' },
    expected: allow('issue.read'),
  },
  {
    name: 'repo.read allows pull_request.read through the action hierarchy',
    permissions: permissions(SCOPE, ['repo.read'], [], []),
    resource: PAYMENTS,
    action: { type: 'pull_request.read', method: 'GET' },
    expected: allow('pull_request.read'),
  },
  {
    name: 'the hierarchy is one-way: issue.read does not grant repo.read',
    permissions: permissions(SCOPE, ['issue.read'], [], []),
    resource: PAYMENTS,
    action: { type: 'repo.read', method: 'GET' },
    expected: defaultDeny('repo.read'),
  },
  {
    name: 'an action nobody listed is denied by default',
    permissions: permissions(SCOPE, ['repo.read'], [], []),
    resource: PAYMENTS,
    action: { type: 'repository.delete', method: 'DELETE' },
    expected: defaultDeny('repository.delete'),
  },
  {
    name: 'a mission granting nothing denies everything',
    permissions: permissions(SCOPE, [], [], []),
    resource: PAYMENTS,
    action: { type: 'repo.read', method: 'GET' },
    expected: defaultDeny('repo.read'),
  },
  {
    name: 'a denied action is denied',
    permissions: permissions(SCOPE, [], [], ['repository.delete']),
    resource: PAYMENTS,
    action: { type: 'repository.delete', method: 'DELETE' },
    expected: denied('repository.delete'),
  },
  {
    name: 'denied beats allowed',
    permissions: permissions(SCOPE, ['repository.delete'], [], ['repository.delete']),
    resource: PAYMENTS,
    action: { type: 'repository.delete', method: 'DELETE' },
    expected: denied('repository.delete'),
  },
  {
    name: 'denied beats approval required',
    permissions: permissions(SCOPE, [], ['repository.delete'], ['repository.delete']),
    resource: PAYMENTS,
    action: { type: 'repository.delete', method: 'DELETE' },
    expected: denied('repository.delete'),
  },
  {
    name: 'denied beats both at once',
    permissions: permissions(
      SCOPE,
      ['repository.delete'],
      ['repository.delete'],
      ['repository.delete'],
    ),
    resource: PAYMENTS,
    action: { type: 'repository.delete', method: 'DELETE' },
    expected: denied('repository.delete'),
  },
  {
    name: 'denying repo.read also denies the reads it would have covered',
    permissions: permissions(SCOPE, ['repo.read'], [], ['repo.read']),
    resource: PAYMENTS,
    action: { type: 'issue.read', method: 'GET' },
    expected: denied('issue.read'),
  },
  {
    name: 'an action in both allowed and approval required needs an approval',
    permissions: permissions(
      SCOPE,
      ['repo.read', 'pull_request.create'],
      ['pull_request.create'],
      [],
    ),
    resource: PAYMENTS,
    action: { type: 'pull_request.create', method: 'POST' },
    expected: approval('pull_request.create'),
  },
  {
    name: 'an approval-only action needs an approval without being allowed anywhere',
    permissions: permissions(SCOPE, [], ['pull_request.merge'], []),
    resource: PAYMENTS,
    action: { type: 'pull_request.merge', method: 'PUT' },
    expected: approval('pull_request.merge'),
  },
  {
    name: 'gating repo.read also gates the reads it covers',
    permissions: permissions(SCOPE, ['repo.read'], ['repo.read'], []),
    resource: PAYMENTS,
    action: { type: 'pull_request.read', method: 'GET' },
    expected: approval('pull_request.read'),
  },
  {
    name: 'an approval on a sibling action leaves the allowed one alone',
    permissions: permissions(
      SCOPE,
      ['repo.read', 'pull_request.create'],
      ['pull_request.create'],
      [],
    ),
    resource: PAYMENTS,
    action: { type: 'repo.read', method: 'GET' },
    expected: allow('repo.read'),
  },
  {
    name: 'an allowed action on an out-of-scope repository is still denied',
    permissions: permissions(SCOPE, ['repo.read'], [], []),
    resource: { provider: 'github', id: 'acme/secrets' },
    action: { type: 'repo.read', method: 'GET' },
    expected: outOfScope('github:acme/secrets'),
  },
  {
    name: 'scope is checked before the denied list',
    permissions: permissions(SCOPE, [], [], ['repository.delete']),
    resource: { provider: 'github', id: 'acme/secrets' },
    action: { type: 'repository.delete', method: 'DELETE' },
    expected: outOfScope('github:acme/secrets'),
  },
  {
    name: 'scope is checked before the approval list',
    permissions: permissions(SCOPE, [], ['pull_request.merge'], []),
    resource: { provider: 'github', id: 'acme/secrets' },
    action: { type: 'pull_request.merge', method: 'PUT' },
    expected: outOfScope('github:acme/secrets'),
  },
  {
    name: 'a mission scoped to nothing denies its own actions',
    permissions: permissions([], ['repo.read'], [], []),
    resource: PAYMENTS,
    action: { type: 'repo.read', method: 'GET' },
    expected: outOfScope('github:acme/payments'),
  },
  {
    name: 'the provider is part of the scope key',
    permissions: permissions(SCOPE, ['repo.read'], [], []),
    resource: { provider: 'gitlab', id: 'acme/payments' },
    action: { type: 'repo.read', method: 'GET' },
    expected: outOfScope('gitlab:acme/payments'),
  },
  {
    name: 'the scope key is compared whole, not by prefix',
    permissions: permissions(SCOPE, ['repo.read'], [], []),
    resource: { provider: 'github', id: 'acme/payments-staging' },
    action: { type: 'repo.read', method: 'GET' },
    expected: outOfScope('github:acme/payments-staging'),
  },
  {
    name: 'there is no wildcard in the scope list',
    permissions: permissions(['github:acme/*'], ['repo.read'], [], []),
    resource: PAYMENTS,
    action: { type: 'repo.read', method: 'GET' },
    expected: outOfScope('github:acme/payments'),
  },
];

/** One well-formed case, for tests about plumbing rather than about precedence. */
export const SAMPLE_CASE: DecisionCase = {
  name: 'a plain allowed read',
  permissions: permissions(SCOPE, ['repo.read'], [], []),
  resource: PAYMENTS,
  action: { type: 'repo.read', method: 'GET' },
  expected: allow('repo.read'),
};

/** Wraps a case into the full input, with the fields the engine must not read held constant. */
export function inputFor(decisionCase: DecisionCase): PolicyInput {
  return {
    identity: { principalId: 'usr_1', agentId: 'agt_1', agentType: 'claude-code' },
    mission: {
      id: 'msn_1',
      intent: 'triage the payments backlog',
      permissions: decisionCase.permissions,
      network: { allow: [{ host: 'api.github.com' }], deny: [] },
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
    resource: decisionCase.resource,
    action: decisionCase.action,
    network: { host: 'api.github.com', path: '/repos/acme/payments' },
    environment: { name: 'test' },
    currentState: { requestCount: 0, bytesTotal: 0 },
    data: {},
  };
}
