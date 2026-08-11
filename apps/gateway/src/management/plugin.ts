import { createHash, timingSafeEqual } from 'node:crypto';
import { AgentGateError } from '@agentgate/shared';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ApprovalService } from '../approvals/service.js';
import { parseBearer } from '../http/bearer.js';
import { registerSensitive } from '../logging.js';
import { createApprovalManagementRoutes } from './approvals.routes.js';

export interface ManagementDeps {
  approvals: ApprovalService;
  /** The one credential that can decide an approval. Required at boot, never logged. */
  adminToken: string;
}

/**
 * Compared as digests rather than as strings: `timingSafeEqual` throws on a length mismatch,
 * so comparing the raw values would answer "how long is the admin token" to anyone willing to
 * send a few requests. Two SHA-256 digests are always the same length and always compared in
 * constant time.
 */
function tokenMatches(expected: string, presented: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(presented, 'utf8').digest(),
    createHash('sha256').update(expected, 'utf8').digest(),
  );
}

/**
 * The management tree (D11). Separate plugin, separate wiring, separate credential: nothing in
 * enforcement imports anything from here, so the code that decides whether a request may go
 * through cannot be reached by the code that answers a human's browser.
 *
 * Sub-plan 08 extends this tree with the rest of the management API; the guard below is what
 * every route registered under it inherits.
 */
export function createManagementRoutes(deps: ManagementDeps): FastifyPluginAsync {
  // Taught to the scrubber here rather than at the call site: the tree that holds the admin
  // token is the tree that guarantees no log line can carry it, however it gets there.
  registerSensitive(deps.adminToken);

  return async (app: FastifyInstance): Promise<void> => {
    // onRequest: before a body is read, before a route handler exists. An unauthenticated
    // caller must not be able to make the gateway parse anything it sent.
    app.addHook('onRequest', async (request) => {
      const presented = parseBearer(request.headers.authorization);

      if (presented === undefined || !tokenMatches(deps.adminToken, presented)) {
        // One answer for a missing token and a wrong one: which of the two it was is not
        // something a caller needs, and telling it apart is free reconnaissance.
        request.log.warn({ url: request.url }, 'management request refused');

        throw new AgentGateError('agentgate_invalid_token', 401, 'Admin token is invalid');
      }
    });

    await app.register(createApprovalManagementRoutes(deps), { prefix: '/api/v1' });
  };
}
