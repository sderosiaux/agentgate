import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, expect, test } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../src/db.js';
import {
  APPROVAL_GRANT_TTL_MS,
  createApprovalService,
  requestBindingHash,
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

/** The request every approval in this file is about, in the shape the pipeline hands over. */
const SUMMARY = {
  method: 'POST',
  host: 'api.github.com',
  path: '/repos/acme/payments/pulls',
  bodySize: 42,
  bodyHash: 'a'.repeat(64),
  contentType: 'application/json',
} as const;

function binding() {
  return {
    missionId,
    agentId,
    resource: 'github:acme/payments',
    action: 'pull_request.create',
    requestHash: requestBindingHash(SUMMARY),
  };
}

async function pending() {
  return service.createPending({
    ...binding(),
    reason: 'Creating a pull request requires human approval.',
    requestSummary: { ...SUMMARY },
  });
}

type ApprovalRecord = Awaited<ReturnType<typeof prisma.approval.findUniqueOrThrow>>;

/**
 * A client with one or two calls swapped out, so a test can pin an interleaving that is
 * otherwise a matter of microseconds. Everything this does not name goes to the real database,
 * which is the point: the rows the service writes are real rows, checked afterwards.
 */
function clientWith(patch: {
  /** Wraps the read that explains why a consume refused. */
  onLookup?: (real: () => Promise<ApprovalRecord | null>) => Promise<ApprovalRecord | null>;
  /** Makes the conditional UPDATE report that it applied to nothing. */
  consumeApplies?: false;
}): PrismaClient {
  const approval = new Proxy(prisma.approval as object, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;

      if (property === 'findUnique' && patch.onLookup !== undefined) {
        return async (args: unknown) =>
          patch.onLookup?.(async () =>
            (value as (a: unknown) => Promise<ApprovalRecord | null>).call(target, args),
          );
      }

      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return new Proxy(prisma as object, {
    get(target, property) {
      if (property === 'approval') {
        return approval;
      }
      if (property === '$queryRaw' && patch.consumeApplies === false) {
        return async () => [];
      }

      const value = Reflect.get(target, property) as unknown;

      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as PrismaClient;
}

test('a human deciding between the update and the read does not lose their grant', async () => {
  const { approvalId } = await pending();

  // The interleaving: the agent presents the id while the row is still pending, so the
  // conditional update refuses it — and the human approves before the read that explains why.
  const racing = createApprovalService(
    clientWith({
      onLookup: async (real) => {
        await service.approve(approvalId, 'alice');

        return real();
      },
    }),
    () => clock.now,
  );

  const outcome = await racing.tryConsume(approvalId, binding());

  // Honest about the moment that decided: at the update, this approval was not approved.
  expect(outcome).toBe('not_approved');

  // And the human's decision survives being observed.
  const row = await prisma.approval.findUniqueOrThrow({ where: { id: approvalId } });
  expect(row.status).toBe('approved');
  expect(row.grantExpiresAt).toEqual(new Date(clock.now.getTime() + APPROVAL_GRANT_TTL_MS));

  expect(await service.tryConsume(approvalId, binding())).toBe('consumed');
});

test('the expiry marking cannot reach a grant that has not expired', async () => {
  const { approvalId } = await pending();
  await service.approve(approvalId, 'alice');

  // Defence in depth: whatever the explaining read believes — here a copy claiming the
  // deadline has passed while the real row is fresh — the write it triggers must not be able
  // to expire a live grant. This is the guard on the marking statement itself.
  const lying = createApprovalService(
    clientWith({
      consumeApplies: false,
      onLookup: async (real) => {
        const row = await real();

        return row === null ? null : { ...row, grantExpiresAt: new Date(clock.now.getTime() - 1) };
      },
    }),
    () => clock.now,
  );

  expect(await lying.tryConsume(approvalId, binding())).toBe('expired');

  const row = await prisma.approval.findUniqueOrThrow({ where: { id: approvalId } });
  expect(row.status).toBe('approved');
  expect(await service.tryConsume(approvalId, binding())).toBe('consumed');
});

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
  expect(row.requestSummary).toEqual({ ...SUMMARY });
  expect(row.requestHash).toBe(requestBindingHash(SUMMARY));
});

test('asking twice for the same request returns the pending approval already waiting', async () => {
  const first = await pending();
  const second = await pending();

  expect(second).toEqual({ approvalId: first.approvalId, created: false });
  expect(await prisma.approval.count({ where: { missionId } })).toBe(1);
});

test('sixteen callers asking at once end up with one question, not sixteen', async () => {
  const outcomes = await Promise.all(Array.from({ length: 16 }, async () => pending()));

  expect(new Set(outcomes.map((outcome) => outcome.approvalId))).toHaveLength(1);
  // Exactly one of them wrote the row; the other fifteen lost the insert and read it back.
  expect(outcomes.filter((outcome) => outcome.created)).toHaveLength(1);
  expect(await prisma.approval.count({ where: { missionId } })).toBe(1);
});

test('one pending approval per request is a database constraint, not a convention', async () => {
  const { approvalId } = await pending();

  await expect(
    prisma.approval.create({
      data: {
        id: 'apr_second_for_the_same_request',
        missionId,
        agentId,
        resource: 'github:acme/payments',
        action: 'pull_request.create',
        requestHash: requestBindingHash(SUMMARY),
        reason: 'a second question about the same thing',
        requestSummary: { method: 'POST', host: 'api.github.com', path: '/x' },
        status: 'pending',
        requestedAt: clock.now,
      },
    }),
  ).rejects.toMatchObject({ code: 'P2002' });

  // A decided question frees the slot: the constraint is on questions still waiting, not on
  // every approval an agent ever asked for.
  await service.deny(approvalId, 'alice');
  expect((await pending()).created).toBe(true);
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
    requestSummary: { ...SUMMARY },
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

test('a grant is bound to the five things it was granted for', async () => {
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
  // The fifth is the one that was missing: same mission, same agent, same resource, same
  // action, a different concrete request.
  expect(
    await service.tryConsume(approvalId, {
      ...binding(),
      requestHash: requestBindingHash({ ...SUMMARY, path: '/repos/acme/payments/pulls/9/merge' }),
    }),
  ).toBe('mismatch');

  // None of the five attempts spent it.
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
  // Partial, so Prisma cannot declare it and only the migration keeps it alive.
  expect(indexes.map((index) => index.indexname)).toContain('Approval_pending_request_key');
});

test('the list is filtered by status and by mission, newest first', async () => {
  const first = await pending();
  await service.approve(first.approvalId, 'alice');
  clock.now = new Date(clock.now.getTime() + 1_000);
  const otherRequest = {
    method: 'POST',
    host: 'api.github.com',
    path: '/repos/acme/payments/git/refs',
  };
  const second = await service.createPending({
    ...binding(),
    action: 'branch.create',
    requestHash: requestBindingHash(otherRequest),
    reason: 'gated',
    requestSummary: otherRequest,
  });

  const all = await service.list({ missionId });
  expect(all.items.map((approval) => approval.id)).toEqual([second.approvalId, first.approvalId]);
  expect(all.nextCursor).toBeNull();

  const approved = await service.list({ missionId, status: 'approved' });
  expect(approved.items.map((approval) => approval.id)).toEqual([first.approvalId]);

  expect(await service.list({ missionId: 'mis_nobody' })).toEqual({ items: [], nextCursor: null });

  // One page at a time, and the cursor is what makes the second page start where the first
  // stopped rather than at the top again.
  const firstPage = await service.list({ missionId, limit: 1 });
  expect(firstPage.items.map((approval) => approval.id)).toEqual([second.approvalId]);
  expect(firstPage.nextCursor).toBe(second.approvalId);

  const secondPage = await service.list({
    missionId,
    limit: 1,
    cursor: firstPage.nextCursor ?? '',
  });
  expect(secondPage.items.map((approval) => approval.id)).toEqual([first.approvalId]);
  expect(secondPage.nextCursor).toBeNull();
});
