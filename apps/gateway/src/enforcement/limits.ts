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
 * Enough slack for any response a REST API returns, so that a mission with almost nothing left
 * still gets a whole answer to its last request rather than a truncated one. It only ever
 * matters at the very end of a budget: everywhere else the remaining budget is the larger number.
 */
export const RESPONSE_SLACK_BYTES = 256 * 1024;

/**
 * The most response budget one request may hold at once, and therefore the largest response the
 * gateway will read for it.
 *
 * A reservation has to be a number the gateway picks before the answer exists, and it is
 * charged for the whole time the request is in flight. Reserving the mission's entire remaining
 * budget would be sound and useless: the first request of a burst would take everything and the
 * rest would be refused while it ran. Reserving a fixed small amount would be the opposite
 * mistake — it would cap every response at that size.
 *
 * 8 MiB is `PROXY_BODY_LIMIT_BYTES` read from the other direction: the gateway will read
 * 8 MiB of request body and hold 8 MiB of response budget per request. The cost is stated
 * rather than hidden — a mission can have at most `maxBytes / (this + slack)` requests in
 * flight at once, which on the demo's 50 MB budget is five. A mission that needs more parallel
 * requests is a mission whose byte budget is too small for what it is doing.
 */
export const RESPONSE_RESERVATION_CAP_BYTES = 8 * 1024 * 1024;

/**
 * Books the body this request is about to send against the mission budget (SPEC D8).
 *
 * A write, not a read, and that is the whole point. The old check read `bytesTotal`, compared
 * it, and left it alone until the upstream had answered — so a handful of simultaneous requests
 * all saw the same room left and were all told to go ahead. Booking the bytes is how the second
 * one sees the first. The condition is re-evaluated against the row this statement locks, so
 * two callers cannot both pass it.
 *
 * False when there is no room, and the caller refuses the request before anything is sent.
 */
export async function reserveRequestBytes(
  prisma: PrismaClient,
  missionId: string,
  limits: MissionLimits,
  requestBytes: number,
): Promise<boolean> {
  const request = BigInt(Math.max(0, Math.trunc(requestBytes)));

  const applied = await prisma.$executeRaw`
    UPDATE "UsageCounter"
       SET "bytesTotal" = "bytesTotal" + ${request}
     WHERE "missionId" = ${missionId}
       AND "bytesTotal" + ${request} <= ${BigInt(limits.maxBytes)}
  `;

  return applied > 0;
}

/**
 * Books what the upstream is allowed to answer with, and hands back that number.
 *
 * Taken immediately before the forward and given back immediately after, because it is the
 * large one: a request that never reaches an upstream — gated behind an approval, refused by a
 * rule — must not be holding several megabytes of a mission's budget while it waits for a
 * human. That was measured: reserving it at step 3 turned a burst of 24 retries of one gated
 * request into five 202s and nineteen 429s.
 *
 * The amount is what the mission can still afford, capped, plus the slack. Reserving it is what
 * makes the cap on the response real under concurrency — the alternative is what the reviewer
 * found, where every request in flight is told it may read the same remaining budget.
 *
 * `FOR UPDATE` is what makes the arithmetic honest. Without it the CTE reads the row from the
 * statement's snapshot while the UPDATE re-reads whatever the last committed writer left, and
 * the two disagree exactly when it matters. With it, the byte-budget arithmetic for one mission
 * lines up behind itself, which is one row's worth of serialisation and no more.
 *
 * `null` when the mission is already at its ceiling. The caller refuses with the byte budget as
 * the reason — before the forward, so nothing has happened upstream. A request that had already
 * spent an approval grant loses it, the same way an upstream timeout would: the grant paid for
 * an attempt, and this is the attempt failing.
 */
export async function reserveResponseAllowance(
  prisma: PrismaClient,
  missionId: string,
  limits: MissionLimits,
): Promise<number | null> {
  const maxBytes = BigInt(limits.maxBytes);
  const cap = BigInt(RESPONSE_RESERVATION_CAP_BYTES);
  const slack = BigInt(RESPONSE_SLACK_BYTES);

  const [row] = await prisma.$queryRaw<{ allowance: bigint }[]>`
    WITH locked AS (
      SELECT "bytesTotal" AS total
        FROM "UsageCounter"
       WHERE "missionId" = ${missionId}
         FOR UPDATE
    ), plan AS (
      SELECT LEAST(GREATEST(${maxBytes}::bigint - total, 0), ${cap}::bigint)
             + ${slack}::bigint AS allowance
        FROM locked
       WHERE total <= ${maxBytes}::bigint
    )
    UPDATE "UsageCounter"
       SET "bytesTotal" = "UsageCounter"."bytesTotal" + plan.allowance
      FROM plan
     WHERE "UsageCounter"."missionId" = ${missionId}
    RETURNING plan.allowance AS allowance
  `;

  return row === undefined ? null : toCount(row.allowance);
}

/**
 * Gives back the part of what was booked that the request did not use.
 *
 * Called on every way out, including the ones that failed: bytes booked and never released are
 * budget a mission has spent on nothing, and a gateway that leaks them turns one upstream
 * outage into a mission that can no longer make requests.
 */
export async function releaseBytes(
  prisma: PrismaClient,
  missionId: string,
  bytes: number,
): Promise<void> {
  const release = Math.trunc(bytes);

  if (release <= 0) {
    return;
  }

  await prisma.$executeRaw`
    UPDATE "UsageCounter"
       SET "bytesTotal" = GREATEST("bytesTotal" - ${BigInt(release)}, 0)
     WHERE "missionId" = ${missionId}
  `;
}
