import { AgentGateError, newId } from '@agentgate/shared';
import { z } from 'zod';
import type { PrismaClient } from '../db.js';
import { DEFAULT_PAGE_SIZE, olderThan, pageOf, type Page, type PageAnchor } from '../pagination.js';

/**
 * How long a granted approval stays usable (SPEC D7).
 *
 * Five minutes is long enough for an agent polling its approval to notice and retry, and short
 * enough that a grant left lying around is worthless: an approval is permission to make one
 * request now, not permission the agent gets to keep.
 */
export const APPROVAL_GRANT_TTL_MS = 5 * 60 * 1000;

export const APPROVAL_STATUSES = ['pending', 'approved', 'denied', 'expired', 'consumed'] as const;

export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/**
 * The four things a grant is bound to (SPEC D7). Deliberately not the body: an approved
 * `pull_request.create` does not pin the title or the branch, which THREAT_MODEL.md records
 * as a prototype limitation rather than an oversight.
 */
export interface ApprovalBinding {
  missionId: string;
  agentId: string;
  resource: string;
  action: string;
}

/** What a human needs to see to decide. Metadata only — never the body (D10). */
export interface ApprovalRequestSummary {
  method: string;
  host: string;
  path: string;
  bodySize?: number | undefined;
  contentType?: string | undefined;
}

export interface CreatePendingInput extends ApprovalBinding {
  reason: string;
  requestSummary: ApprovalRequestSummary;
}

/**
 * Why a grant did not apply. `consumed` is the one success; the other five are the ways an
 * approval can exist and still authorise nothing, kept apart so the audit trail can say which.
 *
 * `already_consumed` is not in sub-plan 07's sketch of this type, which folds reuse into
 * `not_approved`. Reuse of a spent grant is the attack this whole mechanism exists to stop —
 * the trail has to be able to name it.
 */
export type ConsumeOutcome =
  'consumed' | 'already_consumed' | 'not_found' | 'not_approved' | 'expired' | 'mismatch';

/** An approval as anything outside this module gets to see it. */
export interface ApprovalView {
  id: string;
  missionId: string;
  agentId: string;
  resource: string;
  action: string;
  reason: string;
  requestSummary: ApprovalRequestSummary;
  status: ApprovalStatus;
  requestedAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;
  grantExpiresAt: Date | null;
  consumedAt: Date | null;
}

export interface ApprovalListFilter {
  status?: ApprovalStatus | undefined;
  missionId?: string | undefined;
  /** Defaults to {@link DEFAULT_PAGE_SIZE}. The caller-facing cap lives at the route. */
  limit?: number | undefined;
  /** The id of the last approval of the previous page. */
  cursor?: string | undefined;
}

export interface ApprovalService {
  /**
   * The pending record a REQUIRE_APPROVAL leaves behind — or the one already waiting for the
   * same (mission, resource, action), so that an agent retrying its request asks a human once
   * rather than once per retry.
   */
  createPending(input: CreatePendingInput): Promise<{ approvalId: string; created: boolean }>;
  approve(id: string, decidedBy: string): Promise<ApprovalView>;
  deny(id: string, decidedBy: string): Promise<ApprovalView>;
  tryConsume(id: string, binding: ApprovalBinding): Promise<ConsumeOutcome>;
  get(id: string): Promise<ApprovalView | null>;
  /** Newest first, one page at a time. See {@link olderThan} for what a cursor means. */
  list(filter: ApprovalListFilter): Promise<Page<ApprovalView>>;
}

/**
 * The summary is a Json column, so nothing in the database guarantees its shape. It is only
 * ever read to be shown to a human, so a row the gateway cannot parse degrades to what it can
 * still say about it rather than failing the request that is trying to display it.
 */
const RequestSummarySchema = z
  .object({
    method: z.string(),
    host: z.string(),
    path: z.string(),
    bodySize: z.number().int().nonnegative().optional(),
    contentType: z.string().optional(),
  })
  .catch({ method: '', host: '', path: '' });

const StatusSchema = z.enum(APPROVAL_STATUSES).catch('pending');

interface ApprovalRow {
  id: string;
  missionId: string;
  agentId: string;
  resource: string;
  action: string;
  reason: string;
  requestSummary: unknown;
  status: string;
  requestedAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;
  grantExpiresAt: Date | null;
  consumedAt: Date | null;
}

function toView(row: ApprovalRow): ApprovalView {
  return {
    ...row,
    status: StatusSchema.parse(row.status),
    requestSummary: RequestSummarySchema.parse(row.requestSummary),
  };
}

/**
 * Which of the six outcomes an approval that survived the conditional update deserves.
 *
 * `now` is not decoration: this used to infer `expired` from "approved, bound, and the update
 * still refused it", which is false in one interleaving that actually happens — the agent
 * presents the id while the row is pending, the update correctly refuses, and a human approves
 * before this read. The row is then approved with five minutes left on it, and the inference
 * called it expired. The deadline is checked, never deduced.
 */
function classify(row: ApprovalRow | null, binding: ApprovalBinding, now: Date): ConsumeOutcome {
  if (row === null) {
    return 'not_found';
  }

  // Checked before the status: a grant pointed at another mission, agent, resource or action is
  // wrong about *what* it authorises, which is a more useful thing to read in the trail than
  // whatever state it happens to be in.
  if (
    row.missionId !== binding.missionId ||
    row.agentId !== binding.agentId ||
    row.resource !== binding.resource ||
    row.action !== binding.action
  ) {
    return 'mismatch';
  }

  if (row.status === 'consumed') {
    return 'already_consumed';
  }

  if (row.status === 'expired') {
    return 'expired';
  }

  if (row.status !== 'approved') {
    return 'not_approved';
  }

  // An approved row always carries a deadline; one that does not is a row this module did not
  // write, and an approval whose expiry cannot be established authorises nothing.
  if (row.grantExpiresAt === null || row.grantExpiresAt.getTime() <= now.getTime()) {
    return 'expired';
  }

  // Approved, bound, and still inside its grant — yet the update refused it, so the row became
  // approved after that statement ran. The update is what decides, and at the moment it ran
  // this approval was not approved; saying so is the honest answer, and it is also the stable
  // one. Retrying the consume here would make the verdict depend on how long a diagnostic read
  // took. The agent is already polling its approval, and its next retry succeeds.
  return 'not_approved';
}

/**
 * A losing insert on the partial unique index, whichever layer names it: Prisma's own code for
 * a unique violation, or the postgres one when the driver hands the error through untranslated.
 */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;

  return code === 'P2002' || code === '23505';
}

/**
 * How many times a racing caller re-reads before giving up. Two rounds cover the race itself;
 * the third only matters if a human decided the winning row in between, which frees the intent
 * and lets this request legitimately open a new one.
 */
const CREATE_PENDING_ATTEMPTS = 3;

/**
 * Approval records and the single-use grants they turn into (SPEC D7).
 *
 * The clock is injected for the same reason the pipeline's is: whether a grant is still good is
 * a decision about a time, and a decision the tests have to be able to move.
 */
export function createApprovalService(prisma: PrismaClient, clock: () => Date): ApprovalService {
  async function findById(id: string): Promise<ApprovalRow | null> {
    return prisma.approval.findUnique({ where: { id } });
  }

  /** The one row the partial unique index allows for an intent, if it exists yet. */
  async function findPending(binding: ApprovalBinding): Promise<ApprovalRow | null> {
    return prisma.approval.findFirst({
      where: {
        missionId: binding.missionId,
        agentId: binding.agentId,
        resource: binding.resource,
        action: binding.action,
        status: 'pending',
      },
    });
  }

  /**
   * Ends a pending approval one way or the other. One conditional update rather than a read
   * followed by a write: two humans clicking at the same time must not produce an approval that
   * is both approved and denied, and the loser has to be told it lost.
   */
  async function decide(
    id: string,
    status: 'approved' | 'denied',
    decidedBy: string,
  ): Promise<ApprovalView> {
    const now = clock();
    const outcome = await prisma.approval.updateMany({
      where: { id, status: 'pending' },
      data: {
        status,
        decidedAt: now,
        decidedBy,
        grantExpiresAt:
          status === 'approved' ? new Date(now.getTime() + APPROVAL_GRANT_TTL_MS) : null,
      },
    });

    if (outcome.count === 0) {
      const existing = await findById(id);

      if (existing === null) {
        throw new AgentGateError('agentgate_not_found', 404, `approval ${id} is unknown`);
      }

      throw new AgentGateError(
        'agentgate_validation_error',
        409,
        `approval ${id} is already ${existing.status}`,
      );
    }

    const decided = await findById(id);
    if (decided === null) {
      throw new AgentGateError('agentgate_not_found', 404, `approval ${id} is unknown`);
    }

    return toView(decided);
  }

  return {
    async createPending(input) {
      // An agent that keeps retrying a gated request must not fill a human's queue with the
      // same question, and looking before creating does not achieve that: 24 concurrent first
      // attempts through the proxy produced 24 pending rows, because all 24 looked before any
      // of them wrote. The partial unique index added in migration
      // 20260811114500_one_pending_approval_per_intent is what actually decides; the read
      // below is the fast path, and losing the insert is how a racer learns who won.
      for (let attempt = 0; attempt < CREATE_PENDING_ATTEMPTS; attempt += 1) {
        const waiting = await findPending(input);

        if (waiting !== null) {
          return { approvalId: waiting.id, created: false };
        }

        const approvalId = newId('apr');

        try {
          await prisma.approval.create({
            data: {
              id: approvalId,
              missionId: input.missionId,
              agentId: input.agentId,
              resource: input.resource,
              action: input.action,
              reason: input.reason,
              requestSummary: { ...input.requestSummary },
              status: 'pending',
              requestedAt: clock(),
            },
          });

          return { approvalId, created: true };
        } catch (error) {
          if (!isUniqueViolation(error)) {
            throw error;
          }
          // Somebody else asked the same question first. Round two reads their row — unless a
          // human decided it in the meantime, in which case this request does need a new one.
        }
      }

      throw new Error(
        `Could not open an approval for ${input.action} on ${input.resource}: the pending row kept changing underneath`,
      );
    },

    async approve(id, decidedBy) {
      return decide(id, 'approved', decidedBy);
    },

    async deny(id, decidedBy) {
      return decide(id, 'denied', decidedBy);
    },

    async tryConsume(id, binding) {
      const now = clock();

      // The whole of D7 in one statement: a grant is spent by the update that checks it, so two
      // callers racing for the same approval cannot both be told yes. Everything after this is
      // only ever explaining a "no" — it can read a stale row without changing the answer.
      const consumed = await prisma.$queryRaw<{ id: string }[]>`
        UPDATE "Approval"
           SET "status" = 'consumed', "consumedAt" = ${now}
         WHERE "id" = ${id}
           AND "status" = 'approved'
           AND "grantExpiresAt" > ${now}
           AND "missionId" = ${binding.missionId}
           AND "agentId" = ${binding.agentId}
           AND "resource" = ${binding.resource}
           AND "action" = ${binding.action}
        RETURNING "id"
      `;

      if (consumed.length > 0) {
        return 'consumed';
      }

      const row = await findById(id);
      const outcome = classify(row, binding, now);

      // Marked on first notice, like an expired mission: a grant whose deadline has passed must
      // not keep telling a human it is approved and waiting to be used.
      //
      // The deadline is re-stated in the WHERE rather than trusted from the row just read. This
      // is the one destructive write in the module — it throws away a human decision — and the
      // row it acts on was read outside any transaction, so it may already be a different row.
      // Restating the condition makes expiring a live grant impossible here even if the
      // classification above ever gets it wrong again.
      if (outcome === 'expired' && row?.status === 'approved') {
        await prisma.approval.updateMany({
          where: { id, status: 'approved', grantExpiresAt: { lte: now } },
          data: { status: 'expired' },
        });
      }

      return outcome;
    },

    async get(id) {
      const row = await findById(id);

      return row === null ? null : toView(row);
    },

    async list(filter) {
      const limit = filter.limit ?? DEFAULT_PAGE_SIZE;

      let anchor: PageAnchor | undefined;
      if (filter.cursor !== undefined) {
        const row = await findById(filter.cursor);

        if (row === null) {
          // A cursor naming no row would quietly answer with the first page again, which reads
          // as "the queue restarted" to whoever is paging through it.
          throw new AgentGateError(
            'agentgate_validation_error',
            400,
            `cursor ${filter.cursor} names no approval`,
          );
        }

        anchor = { at: row.requestedAt, id: row.id };
      }

      const rows = await prisma.approval.findMany({
        where: {
          ...(filter.missionId === undefined ? {} : { missionId: filter.missionId }),
          ...(filter.status === undefined ? {} : { status: filter.status }),
          ...(anchor === undefined ? {} : olderThan('requestedAt', anchor)),
        },
        // Newest first: an approval queue is read from the top, and the id breaks the tie
        // between two requests the clock cannot separate.
        orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });

      const page = pageOf(rows, limit);

      return { items: page.items.map(toView), nextCursor: page.nextCursor };
    },
  };
}
