import type { Approval, Credential, DecisionRecord } from '@/lib/types';

/**
 * The credential list as the management API serves it — with one field the API does not have.
 *
 * `value` is the trap. No endpoint returns a credential value, but a console is one careless
 * spread away from printing whatever the API sent, so the test renders this and asserts the
 * secret is nowhere on screen. It is cast rather than typed because `Credential` deliberately
 * has no such field: the type system is the first line of the same defence.
 */
export const POISONED_CREDENTIALS = [
  {
    id: 'cred_01',
    alias: 'github_work',
    provider: 'github',
    logicalHost: 'api.github.com',
    upstreamBaseUrl: 'http://mock-github:3001',
    injection: { type: 'header', name: 'Authorization' },
    status: 'active',
    value: 'super-secret-github-token',
    ciphertext: 'AAAA.super-secret-github-token.BBBB',
  },
] as unknown as Credential[];

export const SECRET_IN_FIXTURE = 'super-secret-github-token';

/** A real REQUIRE_APPROVAL decision, snapshot and all, in the shape the recorder writes. */
export const DECISION_WITH_SNAPSHOT: DecisionRecord = {
  id: 'aud_000000000000000000001',
  requestId: 'req_000000000000000000001',
  timestamp: '2026-08-11T09:15:04.000Z',
  principalId: 'pri_stephane',
  agentId: 'agt_codex_01',
  missionId: 'mis_payments_423',
  resource: 'github:acme/payments',
  action: 'pull_request.create',
  method: 'POST',
  destHost: 'api.github.com',
  destPath: '/repos/acme/payments/pulls',
  decision: 'REQUIRE_APPROVAL',
  reason: 'Creating a pull request requires human approval.',
  matchedPolicy: 'github-pr-approval',
  approvalId: 'apr_000000000000000000001',
  httpStatus: 202,
  latencyMs: 37,
  bodySize: 184,
  bodyHash: 'sha256:9f2c1d',
  contentType: 'application/json',
  policyInputSnapshot: {
    identity: {
      principalId: 'pri_stephane',
      agentId: 'agt_codex_01',
      agentType: 'codex',
    },
    mission: {
      id: 'mis_payments_423',
      intent: 'Investigate issue #423 and open a pull request',
      permissions: {
        resources: ['github:acme/payments'],
        allowedActions: ['repo.read', 'pull_request.create'],
        approvalActions: ['pull_request.create'],
        deniedActions: ['pull_request.merge'],
        allowedCredentials: ['github_work'],
      },
      network: { allow: [{ host: 'api.github.com' }], deny: [] },
      expiresAt: '2026-08-11T10:00:00.000Z',
    },
    resource: { provider: 'github', id: 'github:acme/payments' },
    action: { type: 'pull_request.create', method: 'POST' },
    network: { host: 'api.github.com', path: '/repos/acme/payments/pulls' },
    environment: { name: 'development' },
    currentState: { requestCount: 42, bytesTotal: 18_432 },
    data: { contentType: 'application/json', bodySize: 184, bodyHash: 'sha256:9f2c1d' },
  },
};

/** An attempt refused before any policy was consulted: the snapshot is null, and that is a fact. */
export const DECISION_WITHOUT_SNAPSHOT: DecisionRecord = {
  id: 'aud_000000000000000000002',
  requestId: 'req_000000000000000000002',
  timestamp: '2026-08-11T09:20:00.000Z',
  principalId: null,
  agentId: null,
  missionId: null,
  resource: null,
  action: null,
  method: 'GET',
  destHost: null,
  destPath: null,
  decision: 'DENY',
  reason: 'Agent token is invalid',
  matchedPolicy: null,
  approvalId: null,
  httpStatus: null,
  latencyMs: 3,
  bodySize: null,
  bodyHash: null,
  contentType: null,
  policyInputSnapshot: null,
};

export const PENDING_APPROVAL: Approval = {
  id: 'apr_000000000000000000001',
  missionId: 'mis_payments_423',
  agentId: 'agt_codex_01',
  resource: 'github:acme/payments',
  action: 'pull_request.create',
  reason: 'Creating a pull request requires human approval.',
  requestSummary: {
    method: 'POST',
    host: 'api.github.com',
    path: '/repos/acme/payments/pulls',
    bodySize: 184,
    contentType: 'application/json',
  },
  status: 'pending',
  requestedAt: '2026-08-11T09:15:04.000Z',
  decidedAt: null,
  decidedBy: null,
  grantExpiresAt: null,
  consumedAt: null,
};
