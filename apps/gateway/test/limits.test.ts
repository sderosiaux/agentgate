import { randomUUID } from 'node:crypto';
import type { MissionLimits } from '@agentgate/shared';
import { afterAll, beforeEach, expect, test } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../src/db.js';
import {
  consumeRequestSlot,
  releaseBytes,
  reserveRequestBytes,
  reserveResponseAllowance,
  RESPONSE_RESERVATION_CAP_BYTES,
  RESPONSE_SLACK_BYTES,
} from '../src/enforcement/limits.js';

const prisma: PrismaClient = createPrismaClient();

const GENEROUS: MissionLimits = {
  maxRequests: 1_000,
  maxBytes: 1_000_000,
  requestsPerMinute: 1_000,
};

const AT_MINUTE = new Date('2026-08-11T10:20:33.412Z');
const NEXT_MINUTE = new Date('2026-08-11T10:21:00.001Z');

let missionId: string;

/** Every id this file minted, so the counter rows it created can be dropped at the end. */
const missionIds: string[] = [];

beforeEach(() => {
  // Counters are keyed by mission and never reset, so every test gets its own mission id
  // rather than trying to clean up after the previous one.
  missionId = `mis_${randomUUID()}`;
  missionIds.push(missionId);
});

afterAll(async () => {
  // Nothing else ever deletes these: without this, a suite run leaves a dozen counter rows
  // behind for missions that never existed anywhere else.
  await prisma.rateWindow.deleteMany({ where: { missionId: { in: missionIds } } });
  await prisma.usageCounter.deleteMany({ where: { missionId: { in: missionIds } } });
  await prisma.$disconnect();
});

test('the first request of a mission consumes slot number one', async () => {
  const outcome = await consumeRequestSlot(prisma, missionId, GENEROUS, AT_MINUTE);

  expect(outcome).toEqual({ ok: true, usage: { requestCount: 1, bytesTotal: 0 } });
});

test('the request after the last allowed one is refused for max_requests', async () => {
  const limits: MissionLimits = { ...GENEROUS, maxRequests: 2 };

  const first = await consumeRequestSlot(prisma, missionId, limits, AT_MINUTE);
  const second = await consumeRequestSlot(prisma, missionId, limits, AT_MINUTE);
  const third = await consumeRequestSlot(prisma, missionId, limits, AT_MINUTE);

  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  expect(third).toMatchObject({ ok: false, reason: 'max_requests' });
});

test('a refused request still consumes its slot, so probing cannot be free', async () => {
  const limits: MissionLimits = { ...GENEROUS, maxRequests: 1 };

  await consumeRequestSlot(prisma, missionId, limits, AT_MINUTE);
  const refused = await consumeRequestSlot(prisma, missionId, limits, AT_MINUTE);
  const refusedAgain = await consumeRequestSlot(prisma, missionId, limits, AT_MINUTE);

  expect(refused).toMatchObject({ ok: false, usage: { requestCount: 2 } });
  expect(refusedAgain).toMatchObject({ ok: false, usage: { requestCount: 3 } });
});

test('the per-minute window refuses the extra request and reopens on the next minute', async () => {
  const limits: MissionLimits = { ...GENEROUS, requestsPerMinute: 2 };

  await consumeRequestSlot(prisma, missionId, limits, AT_MINUTE);
  await consumeRequestSlot(prisma, missionId, limits, new Date(AT_MINUTE.getTime() + 20_000));
  const third = await consumeRequestSlot(prisma, missionId, limits, AT_MINUTE);
  const nextWindow = await consumeRequestSlot(prisma, missionId, limits, NEXT_MINUTE);

  expect(third).toMatchObject({ ok: false, reason: 'rpm' });
  expect(nextWindow.ok).toBe(true);
});

test('max_requests is reported before the per-minute window', async () => {
  const limits: MissionLimits = { maxRequests: 1, maxBytes: 1_000, requestsPerMinute: 1 };

  await consumeRequestSlot(prisma, missionId, limits, AT_MINUTE);
  const refused = await consumeRequestSlot(prisma, missionId, limits, AT_MINUTE);

  expect(refused).toMatchObject({ ok: false, reason: 'max_requests' });
});

test('ten requests racing for four slots hand out exactly four', async () => {
  const limits: MissionLimits = { ...GENEROUS, maxRequests: 4 };

  const outcomes = await Promise.all(
    Array.from({ length: 10 }, () => consumeRequestSlot(prisma, missionId, limits, AT_MINUTE)),
  );

  expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(4);
  // …and every attempt got its own slot number: no two callers read the same counter.
  expect(new Set(outcomes.map((outcome) => outcome.usage.requestCount)).size).toBe(10);
});

test('ten requests racing for four slots in the same minute hand out exactly four', async () => {
  const limits: MissionLimits = { ...GENEROUS, requestsPerMinute: 4 };

  const outcomes = await Promise.all(
    Array.from({ length: 10 }, () => consumeRequestSlot(prisma, missionId, limits, AT_MINUTE)),
  );

  expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(4);
});

/** The counter row every booking updates. The pipeline always has one by then (D3 step 3). */
async function withCounter(bytesTotal = 0): Promise<void> {
  await prisma.usageCounter.create({ data: { missionId, requestCount: 0, bytesTotal } });
}

async function bytesTotal(): Promise<number> {
  const row = await prisma.usageCounter.findUniqueOrThrow({ where: { missionId } });

  return Number(row.bytesTotal);
}

test('booking a request body puts it on the counter before anything is sent', async () => {
  await withCounter();

  expect(await reserveRequestBytes(prisma, missionId, GENEROUS, 400)).toBe(true);
  expect(await reserveRequestBytes(prisma, missionId, GENEROUS, 350)).toBe(true);

  expect(await bytesTotal()).toBe(750);
});

test('a body the mission cannot afford is not booked at all', async () => {
  const limits: MissionLimits = { ...GENEROUS, maxBytes: 1_000 };
  await withCounter(900);

  expect(await reserveRequestBytes(prisma, missionId, limits, 100)).toBe(true);
  expect(await bytesTotal()).toBe(1_000);

  expect(await reserveRequestBytes(prisma, missionId, limits, 1)).toBe(false);
  // Refused means untouched: a booking that did not happen must not cost the mission anything.
  expect(await bytesTotal()).toBe(1_000);
});

test('ten bodies racing for a budget that fits four are booked four times', async () => {
  // The finding this replaces: each of these used to read the same `bytesTotal`, find room, and
  // be told to go ahead, so the budget was handed out ten times over.
  const limits: MissionLimits = { ...GENEROUS, maxBytes: 400 };
  await withCounter();

  const outcomes = await Promise.all(
    Array.from({ length: 10 }, async () => reserveRequestBytes(prisma, missionId, limits, 100)),
  );

  expect(outcomes.filter(Boolean)).toHaveLength(4);
  expect(await bytesTotal()).toBe(400);
});

test('the response allowance is what the mission can still afford, plus enough to answer', async () => {
  const limits: MissionLimits = { ...GENEROUS, maxBytes: 10_000 };
  await withCounter(7_000);

  expect(await reserveResponseAllowance(prisma, missionId, limits)).toBe(
    3_000 + RESPONSE_SLACK_BYTES,
  );
  // And it is booked, not merely computed: that is what stops two requests in flight from each
  // being told they may read the same 3 000 bytes.
  expect(await bytesTotal()).toBe(7_000 + 3_000 + RESPONSE_SLACK_BYTES);
});

test('the response allowance is capped however much budget is left', async () => {
  const limits: MissionLimits = { ...GENEROUS, maxBytes: 400 * 1024 * 1024 };
  await withCounter();

  expect(await reserveResponseAllowance(prisma, missionId, limits)).toBe(
    RESPONSE_RESERVATION_CAP_BYTES + RESPONSE_SLACK_BYTES,
  );
});

test('a spent budget still leaves the slack, and the next request none at all', async () => {
  const limits: MissionLimits = { ...GENEROUS, maxBytes: 10_000 };
  await withCounter(10_000);

  // Exactly at the limit: the last request gets a whole answer rather than a truncated one.
  expect(await reserveResponseAllowance(prisma, missionId, limits)).toBe(RESPONSE_SLACK_BYTES);
  // And the mission is now past it, so nothing more is booked.
  expect(await reserveResponseAllowance(prisma, missionId, limits)).toBeNull();
  expect(await reserveRequestBytes(prisma, missionId, limits, 0)).toBe(false);
});

test('releasing gives back what was booked and never goes below zero', async () => {
  await withCounter();
  await reserveRequestBytes(prisma, missionId, GENEROUS, 1_000);

  await releaseBytes(prisma, missionId, 600);
  expect(await bytesTotal()).toBe(400);

  await releaseBytes(prisma, missionId, 0);
  await releaseBytes(prisma, missionId, -5);
  expect(await bytesTotal()).toBe(400);

  await releaseBytes(prisma, missionId, 10_000);
  expect(await bytesTotal()).toBe(0);
});

test('byte totals past the safe integer range are still comparable', async () => {
  // BIGINT column, JS numbers: a mission that has moved terabytes must not wrap into a
  // negative total and silently reopen its budget.
  await withCounter(Number.MAX_SAFE_INTEGER);

  const outcome = await consumeRequestSlot(prisma, missionId, GENEROUS, AT_MINUTE);

  expect(outcome.usage.bytesTotal).toBe(Number.MAX_SAFE_INTEGER);
  expect(await reserveRequestBytes(prisma, missionId, GENEROUS, 0)).toBe(false);
});
