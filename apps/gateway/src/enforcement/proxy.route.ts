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

      void reply.code(outcome.status).headers(outcome.headers);

      return hasNoBody(outcome.status) ? reply.send() : reply.send(outcome.body);
    });
  };
}
