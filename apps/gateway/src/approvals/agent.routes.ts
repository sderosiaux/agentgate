import type { TokenService } from '@agentgate/auth';
import { AgentGateError } from '@agentgate/shared';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { parseBearer } from '../http/bearer.js';
import type { ApprovalService, ApprovalView } from './service.js';

export interface ApprovalRouteDeps {
  tokenService: TokenService;
  approvals: ApprovalService;
}

/**
 * What an agent may know about its own approval: whether it can retry yet, and what was asked
 * on its behalf. Not the reason, not who decided, not the request summary — an agent polling
 * this endpoint is waiting for a yes or a no, and everything else is a human's business.
 */
interface AgentApprovalView {
  id: string;
  status: string;
  resource: string;
  action: string;
  requestedAt: string;
  decidedAt?: string;
}

function toAgentView(approval: ApprovalView): AgentApprovalView {
  return {
    id: approval.id,
    status: approval.status,
    resource: approval.resource,
    action: approval.action,
    requestedAt: approval.requestedAt.toISOString(),
    ...(approval.decidedAt === null ? {} : { decidedAt: approval.decidedAt.toISOString() }),
  };
}

/**
 * The read side of an approval, for the agent that caused it (SPEC D11: enforcement is
 * `/v1/proxy` plus this). Deciding one is management — this route can only look.
 */
export function createApprovalRoutes(deps: ApprovalRouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance): Promise<void> => {
    app.get<{ Params: { id: string } }>('/v1/approvals/:id', async (request) => {
      const token = parseBearer(request.headers.authorization);
      if (token === undefined) {
        throw new AgentGateError('agentgate_invalid_token', 401, 'Agent token is missing');
      }

      const claims = await deps.tokenService.verify(token);
      const approval = await deps.approvals.get(request.params.id);

      // An approval belonging to another mission is answered exactly like one that does not
      // exist. The alternative — 403 for "yours is not this one" — turns the endpoint into a
      // way of asking whether an id is real, one guess at a time.
      if (approval === null || approval.missionId !== claims.missionId) {
        throw new AgentGateError(
          'agentgate_not_found',
          404,
          `approval ${request.params.id} is unknown`,
        );
      }

      return toAgentView(approval);
    });
  };
}
