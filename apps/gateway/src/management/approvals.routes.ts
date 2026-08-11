import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { APPROVAL_STATUSES, type ApprovalView } from '../approvals/service.js';
import {
  errorResponses,
  IdSchema,
  NextCursorSchema,
  PageQueryFields,
  MAX_ID_LENGTH,
} from './common.js';
import type { ManagementDeps } from './deps.js';

/** Bounds on what a caller writes into a row that a human will later read back. */
const MAX_DECIDED_BY_LENGTH = 128;

/**
 * Who a decision is attributed to when the caller does not say. The management API is guarded
 * by one shared token, which names nobody: `admin` is the honest answer, not a person.
 */
const ANONYMOUS_ADMIN = 'admin';

const ApprovalSchema = z.object({
  id: z.string().describe('apr_xxx'),
  missionId: z.string(),
  agentId: z.string(),
  resource: z.string(),
  action: z.string(),
  reason: z.string(),
  requestSummary: z
    .object({
      method: z.string(),
      host: z.string(),
      path: z.string(),
      bodySize: z.number().int().nonnegative().optional(),
      contentType: z.string().optional(),
    })
    .describe('Metadata about the request, never its body (D10)'),
  status: z.string().describe(APPROVAL_STATUSES.join(' | ')),
  requestedAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  grantExpiresAt: z.string().nullable(),
  consumedAt: z.string().nullable(),
});

const ListQuerySchema = z.strictObject({
  status: z.enum(APPROVAL_STATUSES).optional(),
  missionId: z.string().min(1).max(MAX_ID_LENGTH).optional(),
  ...PageQueryFields,
});

/**
 * `nullish`, not `optional`: a POST sent with no payload at all arrives here as `null`, not as
 * `undefined`, and "I have nothing to add to this decision" is the common case — the caller is
 * a human clicking approve.
 */
const DecisionBodySchema = z
  .strictObject({ decidedBy: z.string().min(1).max(MAX_DECIDED_BY_LENGTH).optional() })
  .nullish();

/** Dates as ISO strings, so the wire shape does not depend on a serialiser's mood. */
function toJson(approval: ApprovalView): z.infer<typeof ApprovalSchema> {
  return {
    ...approval,
    requestedAt: approval.requestedAt.toISOString(),
    decidedAt: approval.decidedAt?.toISOString() ?? null,
    grantExpiresAt: approval.grantExpiresAt?.toISOString() ?? null,
    consumedAt: approval.consumedAt?.toISOString() ?? null,
  };
}

/**
 * The human side of D7: see what is waiting, and decide it. Approving is the only thing in this
 * system that turns a REQUIRE_APPROVAL into a request that goes through, so it is deliberately
 * a separate tree from enforcement, behind a separate credential (D11).
 */
export function createApprovalManagementRoutes(deps: ManagementDeps): FastifyPluginAsyncZod {
  return async (app): Promise<void> => {
    app.get(
      '/approvals',
      {
        schema: {
          tags: ['approvals'],
          summary: 'What is waiting for a human, newest first',
          querystring: ListQuerySchema,
          response: {
            200: z.object({ approvals: z.array(ApprovalSchema), nextCursor: NextCursorSchema }),
            ...errorResponses(400, 401),
          },
        },
      },
      async (request) => {
        const page = await deps.approvals.list(request.query);

        return { approvals: page.items.map(toJson), nextCursor: page.nextCursor };
      },
    );

    app.post(
      '/approvals/:id/approve',
      {
        schema: {
          tags: ['approvals'],
          summary: 'Approve: turns the pending record into one single-use grant (D7)',
          params: z.object({ id: IdSchema }),
          body: DecisionBodySchema,
          response: { 200: ApprovalSchema, ...errorResponses(400, 401, 404, 409) },
        },
      },
      async (request) =>
        toJson(
          await deps.approvals.approve(
            request.params.id,
            request.body?.decidedBy ?? ANONYMOUS_ADMIN,
          ),
        ),
    );

    app.post(
      '/approvals/:id/deny',
      {
        schema: {
          tags: ['approvals'],
          summary: 'Deny',
          params: z.object({ id: IdSchema }),
          body: DecisionBodySchema,
          response: { 200: ApprovalSchema, ...errorResponses(400, 401, 404, 409) },
        },
      },
      async (request) =>
        toJson(
          await deps.approvals.deny(request.params.id, request.body?.decidedBy ?? ANONYMOUS_ADMIN),
        ),
    );
  };
}
