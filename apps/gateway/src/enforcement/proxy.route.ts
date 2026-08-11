import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { handleProxyRequest, type PipelineDeps } from './pipeline.js';

/** A body a 204 or a 304 must not carry, and that `reply.send` would otherwise re-add. */
function hasNoBody(status: number): boolean {
  return status === 204 || status === 304 || (status >= 100 && status < 200);
}

export function createProxyRoutes(deps: PipelineDeps): FastifyPluginAsync {
  return async (app: FastifyInstance): Promise<void> => {
    // Parsing that never fails, so that a malformed envelope is refused by the pipeline and
    // lands in the audit trail like every other attempt (D12) instead of being turned away by
    // the framework with nothing written down. The pipeline's schema is what judges it.
    app.removeAllContentTypeParsers();
    app.addContentTypeParser('*', { parseAs: 'string' }, (_request, body: string, done) => {
      try {
        done(null, body === '' ? undefined : (JSON.parse(body) as unknown));
      } catch {
        done(null, undefined);
      }
    });

    app.post('/v1/proxy', async (request, reply) => {
      const outcome = await handleProxyRequest(
        deps,
        request.id,
        request.headers.authorization,
        request.body,
      );

      // One line per attempt, matching the audit row it was written next to: the trail is for
      // reading later, the log is for watching now. Neither carries a header or a body.
      request.log.info(
        {
          decision: outcome.decision,
          reason: outcome.reason,
          status: outcome.status,
        },
        'proxy attempt',
      );

      // The one header the gateway adds to an upstream response: it is what ties what the agent
      // got to the audit row explaining why it got it.
      void reply
        .code(outcome.status)
        .headers(outcome.headers)
        .header('x-agentgate-request-id', outcome.requestId);

      return hasNoBody(outcome.status) ? reply.send() : reply.send(outcome.body);
    });
  };
}
