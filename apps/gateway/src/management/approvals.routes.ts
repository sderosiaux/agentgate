import { AgentGateError } from '@agentgate/shared';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  APPROVAL_STATUSES,
  type ApprovalService,
  type ApprovalView,
} from '../approvals/service.js';

export interface ApprovalManagementDeps {
  approvals: ApprovalService;
}

/** Bounds on what a caller writes into a row that a human will later read back. */
const MAX_FILTER_LENGTH = 128;
const MAX_DECIDED_BY_LENGTH = 128;

/**
 * Who a decision is attributed to when the caller does not say. The management API is guarded
 * by one shared token, which names nobody: `admin` is the honest answer, not a person.
 */
const ANONYMOUS_ADMIN = 'admin';

const ListQuerySchema = z.strictObject({
  status: z.enum(APPROVAL_STATUSES).optional(),
  missionId: z.string().min(1).max(MAX_FILTER_LENGTH).optional(),
});

const DecisionBodySchema = z
  .strictObject({ decidedBy: z.string().min(1).max(MAX_DECIDED_BY_LENGTH).optional() })
  .nullish();

function parseOrRefuse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    throw new AgentGateError('agentgate_validation_error', 400, `${what} is not well formed`, {
      cause: parsed.error,
    });
  }

  return parsed.data;
}

/** Dates as ISO strings, so the wire shape does not depend on a serialiser's mood. */
function toJson(approval: ApprovalView): Record<string, unknown> {
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
export function createApprovalManagementRoutes(deps: ApprovalManagementDeps): FastifyPluginAsync {
  return async (app: FastifyInstance): Promise<void> => {
    app.get('/approvals', async (request) => {
      const filter = parseOrRefuse(ListQuerySchema, request.query ?? {}, 'query');

      return { approvals: (await deps.approvals.list(filter)).map(toJson) };
    });

    app.post<{ Params: { id: string } }>('/approvals/:id/approve', async (request) => {
      const body = parseOrRefuse(DecisionBodySchema, request.body ?? {}, 'body');

      return toJson(
        await deps.approvals.approve(request.params.id, body?.decidedBy ?? ANONYMOUS_ADMIN),
      );
    });

    app.post<{ Params: { id: string } }>('/approvals/:id/deny', async (request) => {
      const body = parseOrRefuse(DecisionBodySchema, request.body ?? {}, 'body');

      return toJson(
        await deps.approvals.deny(request.params.id, body?.decidedBy ?? ANONYMOUS_ADMIN),
      );
    });
  };
}
