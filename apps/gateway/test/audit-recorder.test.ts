import { randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'vitest';
import { createAuditRecorder, type AuditEventInput } from '../src/audit/recorder.js';
import { createPrismaClient, type PrismaClient } from '../src/db.js';

const prisma: PrismaClient = createPrismaClient();
const recorder = createAuditRecorder(prisma);

function requestId(): string {
  return `req_${randomUUID()}`;
}

afterAll(async () => {
  await prisma.$disconnect();
});

test('a full row survives the round trip', async () => {
  const id = requestId();

  await recorder.record({
    requestId: id,
    principalId: 'pri_stephane',
    agentId: 'agt_demo',
    missionId: 'mis_demo',
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
