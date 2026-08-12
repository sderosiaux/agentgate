import { randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'vitest';
import { createAuditRecorder, type AuditEventInput } from '../src/audit/recorder.js';
import { createPrismaClient, type PrismaClient } from '../src/db.js';

const prisma: PrismaClient = createPrismaClient();
const recorder = createAuditRecorder(prisma);

function requestId(): string {
  return `req_${randomUUID()}`;
}

/**
 * Ids of this run's own, never the demo mission's: the trail is append-only, so a test that
 * borrowed `mis_demo` would leave rows nobody can tell from a real request forever.
 */
const RUN = randomUUID().replaceAll('-', '').slice(0, 12);

afterAll(async () => {
  await prisma.$disconnect();
});

test('a full row survives the round trip', async () => {
  const id = requestId();

  await recorder.record({
    requestId: id,
    principalId: `pri_test_${RUN}`,
    agentId: `agt_test_${RUN}`,
    missionId: `mis_test_${RUN}`,
    resource: 'github:acme/payments',
    action: 'repo.read',
    method: 'GET',
    destHost: 'api.github.com',
    destPath: '/repos/acme/payments',
    decision: 'ALLOW',
    reason: 'action repo.read is allowed by the mission',
    matchedPolicy: 'mission-allowed-action',
    httpStatus: 200,
    latencyMs: 42,
    bodySize: 0,
    bodyHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    contentType: 'application/json',
  });

  const stored = await prisma.auditEvent.findFirstOrThrow({ where: { requestId: id } });

  expect(stored.id).toMatch(/^aud_/);
  expect(stored.decision).toBe('ALLOW');
  expect(stored.resource).toBe('github:acme/payments');
  expect(stored.destPath).toBe('/repos/acme/payments');
  expect(stored.matchedPolicy).toBe('mission-allowed-action');
  expect(stored.httpStatus).toBe(200);
  expect(stored.latencyMs).toBe(42);
  expect(stored.contentType).toBe('application/json');
  expect(stored.timestamp).toBeInstanceOf(Date);
});

test('an attempt whose identity is unknown is still written, with nulls', async () => {
  const id = requestId();

  await recorder.record({
    requestId: id,
    decision: 'ERROR',
    reason: 'Agent token is invalid',
    latencyMs: 3,
    httpStatus: 401,
  });

  const stored = await prisma.auditEvent.findFirstOrThrow({ where: { requestId: id } });

  expect(stored.principalId).toBeNull();
  expect(stored.agentId).toBeNull();
  expect(stored.missionId).toBeNull();
  expect(stored.resource).toBeNull();
  expect(stored.decision).toBe('ERROR');
});

test('a field named after a credential is refused before anything is written', async () => {
  const id = requestId();
  const event = {
    requestId: id,
    decision: 'ALLOW',
    reason: 'ok',
    latencyMs: 1,
    authorization: 'Bearer super-secret-github-token',
  } as unknown as AuditEventInput;

  await expect(recorder.record(event)).rejects.toThrow(/authorization/);
  expect(await prisma.auditEvent.findFirst({ where: { requestId: id } })).toBeNull();
});

test.each(['value', 'token', 'secret', 'body', 'cookie'])(
  'a field named %s is refused',
  async (key) => {
    const event = {
      requestId: requestId(),
      decision: 'DENY',
      reason: 'ok',
      latencyMs: 1,
      [key]: 'super-secret-github-token',
    } as unknown as AuditEventInput;

    await expect(recorder.record(event)).rejects.toThrow(new RegExp(key));
  },
);

test('a field the trail does not know about is refused', async () => {
  const event = {
    requestId: requestId(),
    decision: 'DENY',
    reason: 'ok',
    latencyMs: 1,
    policyInputSnapshot: { anything: true },
  } as unknown as AuditEventInput;

  await expect(recorder.record(event)).rejects.toThrow();
});

/**
 * A snapshot the schema accepts, with whatever the caller wants inside `mission.permissions`.
 *
 * That sub-document is `z.unknown()` on purpose — mission scope is admin-authored and the trail
 * stores it as written — which makes it the one place in a snapshot where the schema has nothing
 * to say. What happens down there is decided by the recursive key scan and by nothing else.
 */
function snapshotWithPermissions(permissions: unknown): Record<string, unknown> {
  return {
    identity: { principalId: 'pri_1', agentId: 'agt_1', agentType: 'codex' },
    mission: {
      id: 'mis_1',
      intent: 'Investigate issue #423',
      permissions,
      network: { allow: [], deny: [] },
      expiresAt: '2026-08-11T12:00:00.000Z',
    },
    resource: { provider: 'github', id: 'acme/payments' },
    action: { type: 'repo.read', method: 'GET' },
    network: { host: 'api.github.com', path: '/repos/acme/payments' },
    environment: { name: 'development' },
    currentState: { requestCount: 1, bytesTotal: 0 },
    data: { bodySize: 0 },
  };
}

const HONEST_PERMISSIONS = {
  resources: ['github:acme/payments'],
  allowedActions: ['repo.read'],
  approvalActions: [],
  deniedActions: [],
  allowedCredentials: ['github_work'],
};

test('a credential-shaped key buried in the mission scope is refused', async () => {
  const id = requestId();
  const event = {
    requestId: id,
    decision: 'ALLOW',
    reason: 'ok',
    latencyMs: 1,
    // Three levels down, inside the one sub-document the schema waves through. A shallow scan
    // sees `policyInputSnapshot` and nothing else, and this row reaches an append-only table
    // carrying a credential that cannot then be taken back out of it.
    policyInputSnapshot: snapshotWithPermissions({ ...HONEST_PERMISSIONS, token: 'ghp_smuggled' }),
  } as unknown as AuditEventInput;

  await expect(recorder.record(event)).rejects.toThrow(
    /policyInputSnapshot\.mission\.permissions\.token/,
  );
  expect(await prisma.auditEvent.findFirst({ where: { requestId: id } })).toBeNull();
});

test('a credential-shaped key inside an array in the mission scope is refused', async () => {
  const event = {
    requestId: requestId(),
    decision: 'ALLOW',
    reason: 'ok',
    latencyMs: 1,
    policyInputSnapshot: snapshotWithPermissions({
      ...HONEST_PERMISSIONS,
      overrides: [{ resource: 'github:acme/payments', secret: 'ghp_smuggled' }],
    }),
  } as unknown as AuditEventInput;

  await expect(recorder.record(event)).rejects.toThrow(/overrides\[0\]\.secret/);
});

test('the same snapshot without the smuggled key is written, so the refusals above mean something', async () => {
  const id = requestId();

  await recorder.record({
    requestId: id,
    decision: 'ALLOW',
    reason: 'ok',
    latencyMs: 1,
    policyInputSnapshot: snapshotWithPermissions(HONEST_PERMISSIONS),
  } as unknown as AuditEventInput);

  const stored = await prisma.auditEvent.findFirstOrThrow({ where: { requestId: id } });

  expect(stored.policyInputSnapshot).toMatchObject({
    mission: { id: 'mis_1', permissions: HONEST_PERMISSIONS },
    action: { type: 'repo.read', method: 'GET' },
  });
});

test('a decision the trail does not know about is refused', async () => {
  const event = {
    requestId: requestId(),
    decision: 'MAYBE',
    reason: 'ok',
    latencyMs: 1,
  } as unknown as AuditEventInput;

  await expect(recorder.record(event)).rejects.toThrow();
});

test('the body metadata fields are stored while the body itself has no column', async () => {
  const id = requestId();

  await recorder.record({
    requestId: id,
    decision: 'REQUIRE_APPROVAL',
    reason: 'action pull_request.create requires an approval',
    latencyMs: 7,
    bodySize: 61,
    bodyHash: 'abc123',
    contentType: 'application/json',
  });

  const stored = await prisma.auditEvent.findFirstOrThrow({ where: { requestId: id } });

  expect(stored.bodySize).toBe(61);
  expect(stored.bodyHash).toBe('abc123');
  expect(Object.keys(stored)).not.toContain('body');
});
