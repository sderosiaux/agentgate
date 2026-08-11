import type { MissionLimits } from '@agentgate/shared';
import type { PrismaClient } from '../db.js';

/** The mission's counters, as they stand after the current request has been accounted for. */
export interface UsageSnapshot {
  requestCount: number;
  bytesTotal: number;
}

export type LimitReason = 'max_requests' | 'rpm';

export type ConsumeResult =
  { ok: true; usage: UsageSnapshot } | { ok: false; reason: LimitReason; usage: UsageSnapshot };

const MINUTE_MS = 60_000;

/** The window a timestamp belongs to. Computed here rather than in SQL, so the injected clock decides. */
function windowStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS);
}

/**
 * `bytesTotal` is a BIGINT, which the driver hands back as a bigint or as a string depending on
 * the column and the adapter. Anything past `Number.MAX_SAFE_INTEGER` clamps rather than
 * wrapping: a mission that has moved more bytes than a double can name is over any limit that
 * fits in one, and rounding it down would reopen a budget that is spent.
 */
function toCount(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }

  const asBigInt = BigInt(value as bigint | string);

  return asBigInt > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(asBigInt);
}

/**
 * Books one request against the mission and answers whether it may proceed (SPEC D8).
 *
 * Both counters are incremented unconditionally and read back in the same statement, so
 * concurrent requests each get their own slot number: the check is on a value nobody else can
 * be holding. A denied request keeps its slot — probing for what a mission may reach costs the
 * same as using it, which is the point.
 *
 * Two statements rather than one transaction: they touch different rows, neither can fail
 * halfway, and a transaction would serialise the very requests this is meant to let race.
 */
export async function consumeRequestSlot(
  prisma: PrismaClient,
  missionId: string,
  limits: MissionLimits,
  now: Date,
): Promise<ConsumeResult> {
  const [counter] = await prisma.$queryRaw<{ requestCount: number; bytesTotal: bigint }[]>`
    INSERT INTO "UsageCounter" ("missionId", "requestCount", "bytesTotal")
    VALUES (${missionId}, 1, 0)
    ON CONFLICT ("missionId")
      DO UPDATE SET "requestCount" = "UsageCounter"."requestCount" + 1
    RETURNING "requestCount", "bytesTotal"
  `;

  const [window] = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO "RateWindow" ("missionId", "minute", "count")
    VALUES (${missionId}, ${windowStart(now)}, 1)
    ON CONFLICT ("missionId", "minute")
      DO UPDATE SET "count" = "RateWindow"."count" + 1
    RETURNING "count"
  `;

  if (counter === undefined || window === undefined) {
    throw new Error(`Usage counters for mission ${missionId} did not return a row`);
  }

  const usage: UsageSnapshot = {
    requestCount: toCount(counter.requestCount),
    bytesTotal: toCount(counter.bytesTotal),
  };

  // The mission budget is reported before the per-minute one: a mission that is out of
  // requests will not become usable by waiting, and saying so is the more useful answer.
  if (usage.requestCount > limits.maxRequests) {
    return { ok: false, reason: 'max_requests', usage };
  }

  if (toCount(window.count) > limits.requestsPerMinute) {
    return { ok: false, reason: 'rpm', usage };
  }

  return { ok: true, usage };
}

/**
 * Adds the bytes a request actually moved — its own body plus the upstream response — to the
 * mission total. Called after the forward, since the response size is not knowable before it.
 */
export async function recordBytes(
  prisma: PrismaClient,
  missionId: string,
  bytes: number,
): Promise<void> {
  if (bytes <= 0) {
    return;
  }

  await prisma.$executeRaw`
    INSERT INTO "UsageCounter" ("missionId", "requestCount", "bytesTotal")
    VALUES (${missionId}, 0, ${BigInt(Math.trunc(bytes))})
    ON CONFLICT ("missionId")
      DO UPDATE SET "bytesTotal" = "UsageCounter"."bytesTotal" + ${BigInt(Math.trunc(bytes))}
  `;
}

/**
 * Checked before forwarding, with the size of the body about to be sent: the response size is
 * unknown at that point, so the budget is enforced on what is already spent plus what this
 * request is asking to spend. A mission can therefore overshoot `maxBytes` by one response —
 * documented, and the alternative is refusing to answer a request already sent upstream.
 */
export function bytesExceeded(
  usage: UsageSnapshot,
  limits: MissionLimits,
  pendingBytes: number,
): boolean {
  return usage.bytesTotal + pendingBytes > limits.maxBytes;
}
