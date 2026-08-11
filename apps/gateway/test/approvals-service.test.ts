import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, expect, test } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../src/db.js';
import {
  APPROVAL_GRANT_TTL_MS,
  createApprovalService,
  type ApprovalService,
} from '../src/approvals/service.js';

const prisma: PrismaClient = createPrismaClient();

/** What the pipeline reads as "now". Mutable, so a test can move the clock past a grant. */
const clock = { now: new Date('2026-08-11T10:00:00.000Z') };

const service: ApprovalService = createApprovalService(prisma, () => clock.now);

let missionId: string;
let agentId: string;

const missionIds: string[] = [];

beforeEach(() => {
  clock.now = new Date('2026-08-11T10:00:00.000Z');
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  missionId = `mis_svc_${suffix}`;
  agentId = `agt_svc_${suffix}`;
  missionIds.push(missionId);
});

afterAll(async () => {
  await prisma.approval.deleteMany({ where: { missionId: { in: missionIds } } });
  await prisma.$disconnect();
});

function binding() {
  return { missionId, agentId, resource: 'github:acme/payments', action: 'pull_request.create' };
}

async function pending() {
  return service.createPending({
    ...binding(),
    reason: 'Creating a pull request requires human approval.',
    requestSummary: {
      method: 'POST',
      host: 'api.github.com',
      path: '/repos/acme/payments/pulls',
      bodySize: 42,
      contentType: 'application/json',
    },
  });
}

test('a pending approval records what was asked, and nothing has been decided yet', async () => {
  const { approvalId, created } = await pending();

  expect(created).toBe(true);
  expect(approvalId).toMatch(/^apr_/);

  const row = await prisma.approval.findUniqueOrThrow({ where: { id: approvalId } });
  expect(row).toMatchObject({
    missionId,
    agentId,
    resource: 'github:acme/payments',
    action: 'pull_request.create',
    status: 'pending',
    reason: 'Creating a pull request requires human approval.',
    decidedAt: null,
    decidedBy: null,
    grantExpiresAt: null,
    consumedAt: null,
  });
  expect(row.requestSummary).toEqual({
    method: 'POST',
    host: 'api.github.com',
    path: '/repos/acme/payments/pulls',
    bodySize: 42,
    contentType: 'application/json',
  });
});

test('asking twice for the same action returns the pending approval already waiting', async () => {
  const first = await pending();
  const second = await pending();

  expect(second).toEqual({ approvalId: first.approvalId, created: false });
  expect(await prisma.approval.count({ where: { missionId } })).toBe(1);
});

test('a decided approval no longer absorbs the next request: a new one is created', async () => {
  const first = await pending();
  await service.deny(first.approvalId, 'alice');

  const second = await pending();

  expect(second.created).toBe(true);
  expect(second.approvalId).not.toBe(first.approvalId);
});

test('another mission asking for the same action gets its own approval', async () => {
  const mine = await pending();
  const otherMission = `mis_svc_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  missionIds.push(otherMission);

  const theirs = await service.createPending({
    ...binding(),
    missionId: otherMission,
    reason: 'Creating a pull request requires human approval.',
    requestSummary: { method: 'POST', host: 'api.github.com', path: '/repos/acme/payments/pulls' },
  });

  expect(theirs.approvalId).not.toBe(mine.approvalId);
});

test('approving stamps the decision and starts a five minute grant', async () => {
  const { approvalId } = await pending();

  const view = await service.approve(approvalId, 'alice');

  expect(view).toMatchObject({ id: approvalId, status: 'approved', decidedBy: 'alice' });
  expect(view.decidedAt).toEqual(clock.now);
  expect(view.grantExpiresAt).toEqual(new Date(clock.now.getTime() + APPROVAL_GRANT_TTL_MS));
  expect(APPROVAL_GRANT_TTL_MS).toBe(5 * 60 * 1000);
});

test('denying stamps the decision and issues no grant', async () => {
  const { approvalId } = await pending();

  const view = await service.deny(approvalId, 'alice');

  expect(view).toMatchObject({ id: approvalId, status: 'denied', decidedBy: 'alice' });
  expect(view.decidedAt).toEqual(clock.now);
  expect(view.grantExpiresAt).toBeNull();
});

test('an approval can only be decided once', async () => {
  const { approvalId } = await pending();
  await service.approve(approvalId, 'alice');

  await expect(service.approve(approvalId, 'bob')).rejects.toMatchObject({ httpStatus: 409 });
  await expect(service.deny(approvalId, 'bob')).rejects.toMatchObject({ httpStatus: 409 });
});

test('deciding an approval nobody created is a 404, not a silent no-op', async () => {
  await expect(service.approve('apr_does_not_exist', 'alice')).rejects.toMatchObject({
    httpStatus: 404,
  });
});

test('an approved grant is consumed exactly once', async () => {
  const { approvalId } = await pending();
  await service.approve(approvalId, 'alice');

  expect(await service.tryConsume(approvalId, binding())).toBe('consumed');
  expect(await service.tryConsume(approvalId, binding())).toBe('already_consumed');

  const row = await prisma.approval.findUniqueOrThrow({ where: { id: approvalId } });
  expect(row.status).toBe('consumed');
  expect(row.consumedAt).toEqual(clock.now);
});

test('two callers racing for the same grant: exactly one wins', async () => {
  const { approvalId } = await pending();
  await service.approve(approvalId, 'alice');

  const outcomes = await Promise.all(
    Array.from({ length: 8 }, async () => service.tryConsume(approvalId, binding())),
  );

  expect(outcomes.filter((outcome) => outcome === 'consumed')).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome === 'already_consumed')).toHaveLength(7);
});

test('a grant is bound to the four things it was granted for', async () => {
  const { approvalId } = await pending();
  await service.approve(approvalId, 'alice');

  expect(await service.tryConsume(approvalId, { ...binding(), action: 'pull_request.merge' })).toBe(
    'mismatch',
  );
  expect(
    await service.tryConsume(approvalId, { ...binding(), resource: 'github:acme/other' }),
  ).toBe('mismatch');
  expect(await service.tryConsume(approvalId, { ...binding(), agentId: 'agt_someone_else' })).toBe(
    'mismatch',
  );
  expect(
    await service.tryConsume(approvalId, { ...binding(), missionId: 'mis_someone_else' }),
  ).toBe('mismatch');

  // None of the four attempts spent it.
  expect(await service.tryConsume(approvalId, binding())).toBe('consumed');
});

test('a grant older than five minutes is spent, and says so on every later attempt', async () => {
  const { approvalId } = await pending();
  await service.approve(approvalId, 'alice');

  clock.now = new Date(clock.now.getTime() + APPROVAL_GRANT_TTL_MS + 1);

  expect(await service.tryConsume(approvalId, binding())).toBe('expired');
  // The row is marked on first notice rather than left claiming to be approved.
  expect((await prisma.approval.findUniqueOrThrow({ where: { id: approvalId } })).status).toBe(
    'expired',
  );
  expect(await service.tryConsume(approvalId, binding())).toBe('expired');
});

test('a grant one millisecond short of its deadline is still good', async () => {
  const { approvalId } = await pending();
  await service.approve(approvalId, 'alice');

  clock.now = new Date(clock.now.getTime() + APPROVAL_GRANT_TTL_MS - 1);

  expect(await service.tryConsume(approvalId, binding())).toBe('consumed');
});

test('an undecided or refused approval grants nothing', async () => {
  const waiting = await pending();
  expect(await service.tryConsume(waiting.approvalId, binding())).toBe('not_approved');

  await service.deny(waiting.approvalId, 'alice');
  expect(await service.tryConsume(waiting.approvalId, binding())).toBe('not_approved');
});

test('an approval id nobody issued consumes nothing', async () => {
  expect(await service.tryConsume('apr_invented', binding())).toBe('not_found');
});

test('the approval lookups this module makes have an index behind them', async () => {
  const indexes = await prisma.$queryRaw<{ indexname: string }[]>`
    SELECT "indexname" FROM "pg_indexes" WHERE "tablename" = 'Approval'
  `;

  expect(indexes.map((index) => index.indexname)).toContain('Approval_missionId_status_idx');
});

test('the list is filtered by status and by mission, newest first', async () => {
  const first = await pending();
  await service.approve(first.approvalId, 'alice');
  clock.now = new Date(clock.now.getTime() + 1_000);
  const second = await service.createPending({
    ...binding(),
    action: 'branch.create',
    reason: 'gated',
    requestSummary: {
      method: 'POST',
      host: 'api.github.com',
      path: '/repos/acme/payments/git/refs',
    },
  });

  const all = await service.list({ missionId });
  expect(all.map((approval) => approval.id)).toEqual([second.approvalId, first.approvalId]);

  const approved = await service.list({ missionId, status: 'approved' });
  expect(approved.map((approval) => approval.id)).toEqual([first.approvalId]);

  expect(await service.list({ missionId: 'mis_nobody' })).toEqual([]);
});
