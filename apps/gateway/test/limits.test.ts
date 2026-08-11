import { randomUUID } from 'node:crypto';
import type { MissionLimits } from '@agentgate/shared';
import { afterAll, beforeEach, expect, test } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../src/db.js';
import {
  bytesExceeded,
  consumeRequestSlot,
  recordBytes,
  responseAllowance,
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

test('recorded bytes accumulate on the mission counter', async () => {
  await consumeRequestSlot(prisma, missionId, GENEROUS, AT_MINUTE);
  await recordBytes(prisma, missionId, 400);
  await recordBytes(prisma, missionId, 350);

  const outcome = await consumeRequestSlot(prisma, missionId, GENEROUS, AT_MINUTE);

  expect(outcome.usage).toEqual({ requestCount: 2, bytesTotal: 750 });
});

test('recording bytes for a mission with no counter yet creates one', async () => {
  await recordBytes(prisma, missionId, 120);

  const outcome = await consumeRequestSlot(prisma, missionId, GENEROUS, AT_MINUTE);

  expect(outcome.usage).toEqual({ requestCount: 1, bytesTotal: 120 });
});

test('bytes already spent plus the pending request decide the byte budget', () => {
  const limits: MissionLimits = { ...GENEROUS, maxBytes: 1_000 };

  expect(bytesExceeded({ requestCount: 1, bytesTotal: 900 }, limits, 100)).toBe(false);
  expect(bytesExceeded({ requestCount: 1, bytesTotal: 900 }, limits, 101)).toBe(true);
  expect(bytesExceeded({ requestCount: 1, bytesTotal: 1_001 }, limits, 0)).toBe(true);
});

test('the response allowance is what the mission can still afford, plus enough to answer', () => {
  const limits: MissionLimits = { ...GENEROUS, maxBytes: 10_000 };

  expect(responseAllowance({ requestCount: 1, bytesTotal: 0 }, limits, 0)).toBe(
    10_000 + RESPONSE_SLACK_BYTES,
  );
  expect(responseAllowance({ requestCount: 1, bytesTotal: 6_000 }, limits, 1_000)).toBe(
    3_000 + RESPONSE_SLACK_BYTES,
  );
  // A spent budget still leaves the slack: the last request gets a whole answer rather than a
  // truncated one, and `bytesExceeded` is what refuses the request after it.
  expect(responseAllowance({ requestCount: 1, bytesTotal: 99_000 }, limits, 0)).toBe(
    RESPONSE_SLACK_BYTES,
  );
});

test('byte totals past the safe integer range are still comparable', async () => {
  // BIGINT column, JS numbers: a mission that has moved terabytes must not wrap into a
  // negative total and silently reopen its budget.
  await recordBytes(prisma, missionId, Number.MAX_SAFE_INTEGER);

  const outcome = await consumeRequestSlot(prisma, missionId, GENEROUS, AT_MINUTE);

  expect(outcome.usage.bytesTotal).toBe(Number.MAX_SAFE_INTEGER);
  expect(bytesExceeded(outcome.usage, GENEROUS, 0)).toBe(true);
});
