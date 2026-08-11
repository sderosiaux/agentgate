import { AgentGateError, newId } from '@agentgate/shared';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Logger } from 'pino';
import { createApprovalRoutes } from './approvals/agent.routes.js';
import type { PipelineDeps } from './enforcement/pipeline.js';
import { createProxyRoutes } from './enforcement/proxy.route.js';
import { replyWithError } from './http/errors.js';
import { createLogger } from './logging.js';
import { createManagementRoutes } from './management/plugin.js';

/**
 * Everything the gateway needs from the outside world, handed in rather than reached for.
 * `index.ts` is the one place that builds the real ones; a test builds its own and gets the
 * same app, wired the same way, with no environment to arrange.
 */
export interface GatewayDeps extends PipelineDeps {
  /** Guards the management tree. Only that tree ever sees it. */
  adminToken: string;
  /**
   * The key credentials are encrypted with. Management needs it to *write* one; the enforcement
   * path never sees it — it reads through `secretStore`, which holds its own copy.
   */
  masterKey: string;
  logger?: Logger;
  fastify?: FastifyServerOptions;
}

export function buildApp(deps: GatewayDeps): FastifyInstance {
  const { logger, fastify, adminToken, masterKey, ...pipeline } = deps;

  // Request ids are AgentGate ids: the same value is echoed as `request_id` in error bodies,
  // stored on every audit event and sent upstream as `x-request-id`.
  const app = Fastify({
    genReqId: () => newId('req'),
    loggerInstance: logger ?? createLogger(),
    ...fastify,
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  // The enforcement tree: the proxy, and the read side of an approval the agent is waiting on.
  void app.register(createProxyRoutes(pipeline));
  void app.register(
    createApprovalRoutes({ tokenService: pipeline.tokenService, approvals: pipeline.approvals }),
  );

  // The management tree, wired separately and guarded by its own credential. Neither tree
  // imports the other (D11): this file is the only place that knows both exist.
  void app.register(
    createManagementRoutes({
      prisma: pipeline.prisma,
      approvals: pipeline.approvals,
      tokenService: pipeline.tokenService,
      clock: pipeline.clock,
      adminToken,
      masterKey,
    }),
  );

  app.setNotFoundHandler(async (request, reply) =>
    reply
      .code(404)
      .send(
        new AgentGateError('agentgate_not_found', 404, 'no such route').toBody(String(request.id)),
      ),
  );

  app.setErrorHandler(async (error, request, reply) => replyWithError(request, reply, error));

  return app;
}
