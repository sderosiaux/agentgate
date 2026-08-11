import { AgentGateError, newId } from '@agentgate/shared';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Logger } from 'pino';
import type { PipelineDeps } from './enforcement/pipeline.js';
import { createProxyRoutes } from './enforcement/proxy.route.js';
import { createLogger } from './logging.js';

/**
 * Everything the gateway needs from the outside world, handed in rather than reached for.
 * `index.ts` is the one place that builds the real ones; a test builds its own and gets the
 * same app, wired the same way, with no environment to arrange.
 */
export interface GatewayDeps extends PipelineDeps {
  logger?: Logger;
  fastify?: FastifyServerOptions;
}

export function buildApp(deps: GatewayDeps): FastifyInstance {
  const { logger, fastify, ...pipeline } = deps;

  // Request ids are AgentGate ids: the same value is echoed as `request_id` in error bodies,
  // stored on every audit event and sent upstream as `x-request-id`.
  const app = Fastify({
    genReqId: () => newId('req'),
    loggerInstance: logger ?? createLogger(),
    ...fastify,
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  // The enforcement tree. Management routes (plan 08) register as their own plugin with their
  // own dependencies, and neither imports the other (D11).
  void app.register(createProxyRoutes(pipeline));

  app.setNotFoundHandler(async (request, reply) =>
    reply
      .code(404)
      .send(
        new AgentGateError('agentgate_not_found', 404, 'no such route').toBody(String(request.id)),
      ),
  );

  app.setErrorHandler(async (error, request, reply) => {
    const requestId = String(request.id);

    if (error instanceof AgentGateError) {
      // Logged with its cause, which is where the real reason lives: what the agent is told is
      // deliberately thinner than what an operator can read.
      request.log.warn({ err: error, code: error.code }, 'request refused');

      return reply.code(error.httpStatus).send(error.toBody(requestId));
    }

    request.log.error({ err: error }, 'request failed');

    return reply
      .code(500)
      .send(
        new AgentGateError('agentgate_upstream_error', 500, 'the gateway could not answer').toBody(
          requestId,
        ),
      );
  });

  return app;
}
