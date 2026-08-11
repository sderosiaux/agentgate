import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AUDIT_DECISIONS } from '../audit/recorder.js';
import {
  badRequest,
  errorResponses,
  IdSchema,
  IsoDateTimeSchema,
  MAX_NAME_LENGTH,
  NextCursorSchema,
  notFound,
  olderThan,
  PageQueryFields,
  pageOf,
} from './common.js';
import type { ManagementDeps } from './deps.js';

/**
 * One row of the trail as the management API serves it. Everything the recorder wrote, and
 * nothing it did not: there is no header, no body and no credential in this shape because
 * there is none in the table (D10).
 */
const AuditEventSchema = z.object({
  id: z.string().describe('aud_xxx'),
  requestId: z.string().describe('req_xxx — the id the agent was handed'),
  timestamp: z.string(),
  principalId: z.string().nullable(),
  agentId: z.string().nullable(),
  missionId: z.string().nullable(),
  resource: z.string().nullable(),
  action: z.string().nullable(),
  method: z.string().nullable(),
  destHost: z.string().nullable(),
  destPath: z.string().nullable(),
  decision: z.string().describe(AUDIT_DECISIONS.join(' | ')),
  reason: z.string(),
  matchedPolicy: z.string().nullable(),
  approvalId: z.string().nullable(),
  httpStatus: z.number().int().nullable(),
  latencyMs: z.number().int(),
  bodySize: z.number().int().nullable(),
  bodyHash: z.string().nullable(),
  contentType: z.string().nullable(),
});

/**
 * The runtime-decision view: the row, plus the question the engine was asked.
 *
 * Null whenever the attempt was refused before the engine was reached — a missing token, an
 * expired mission, an exhausted budget. That is information, not a gap: it says the decision
 * was made by the pipeline rather than by a policy.
 */
const DecisionSchema = AuditEventSchema.extend({
  policyInputSnapshot: z
    .unknown()
    .describe('The PolicyInput evaluated, or null if no policy was reached'),
});

const AuditQuerySchema = z.strictObject({
  agentId: IdSchema.optional(),
  principalId: IdSchema.optional(),
  missionId: IdSchema.optional(),
  resource: z.string().min(1).max(MAX_NAME_LENGTH).optional(),
  decision: z.enum(AUDIT_DECISIONS).optional(),
  from: IsoDateTimeSchema.optional().describe('Inclusive lower bound on timestamp'),
  to: IsoDateTimeSchema.optional().describe('Exclusive upper bound on timestamp'),
  ...PageQueryFields,
});

/** The one column that is not already a wire value. Everything else passes through as selected. */
function toJson<T extends { timestamp: Date }>(
  row: T,
): Omit<T, 'timestamp'> & { timestamp: string } {
  return { ...row, timestamp: row.timestamp.toISOString() };
}

const AUDIT_COLUMNS = {
  id: true,
  requestId: true,
  timestamp: true,
  principalId: true,
  agentId: true,
  missionId: true,
  resource: true,
  action: true,
  method: true,
  destHost: true,
  destPath: true,
  decision: true,
  reason: true,
  matchedPolicy: true,
  approvalId: true,
  httpStatus: true,
  latencyMs: true,
  bodySize: true,
  bodyHash: true,
  contentType: true,
} as const;

export function createAuditRoutes(deps: ManagementDeps): FastifyPluginAsyncZod {
  return async (app): Promise<void> => {
    app.get(
      '/audit',
      {
        schema: {
          tags: ['audit'],
          summary: 'Read the trail, newest first',
          querystring: AuditQuerySchema,
          response: {
            200: z.object({ events: z.array(AuditEventSchema), nextCursor: NextCursorSchema }),
            ...errorResponses(400, 401),
          },
        },
      },
      async (request) => {
        const { limit, cursor, from, to, decision, ...filters } = request.query;

        let anchor: { at: Date; id: string } | undefined;
        if (cursor !== undefined) {
          const row = await deps.prisma.auditEvent.findUnique({
            where: { id: cursor },
            select: { id: true, timestamp: true },
          });
          if (row === null) {
            // A cursor naming no row would silently answer with the first page again, which
            // reads as "the list restarted" to whoever is paging through it.
            throw badRequest(`cursor ${cursor} names no audit event`);
          }
          anchor = { at: row.timestamp, id: row.id };
        }

        const timestamp = {
          ...(from === undefined ? {} : { gte: new Date(from) }),
          ...(to === undefined ? {} : { lt: new Date(to) }),
        };

        const rows = await deps.prisma.auditEvent.findMany({
          where: {
            ...Object.fromEntries(
              Object.entries(filters).filter(([, value]) => value !== undefined),
            ),
            ...(decision === undefined ? {} : { decision }),
            ...(Object.keys(timestamp).length === 0 ? {} : { timestamp }),
            ...(anchor === undefined ? {} : olderThan('timestamp', anchor)),
          },
          orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
          // One more than asked for: the extra row is how the page knows there is a next one
          // without a second count query over a table that only grows.
          take: limit + 1,
          select: AUDIT_COLUMNS,
        });

        const page = pageOf(rows, limit);

        return { events: page.items.map(toJson), nextCursor: page.nextCursor };
      },
    );

    app.get(
      '/decisions/:requestId',
      {
        schema: {
          tags: ['audit'],
          summary: 'One decision, with the policy input it was made from',
          params: z.object({ requestId: IdSchema }),
          response: { 200: DecisionSchema, ...errorResponses(401, 404) },
        },
      },
      async (request) => {
        // By request id, not by row id: the request id is what the agent was handed and what an
        // operator has in front of them when they come asking why.
        const row = await deps.prisma.auditEvent.findFirst({
          where: { requestId: request.params.requestId },
          orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
          select: { ...AUDIT_COLUMNS, policyInputSnapshot: true },
        });

        if (row === null) {
          throw notFound(`decision ${request.params.requestId}`);
        }

        return toJson(row);
      },
    );
  };
}
