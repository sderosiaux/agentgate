import type {
  FastifyError,
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import {
  handleProxyRequest,
  OVERSIZED_BODY,
  type PipelineDeps,
  type ProxyOutcome,
} from './pipeline.js';

/**
 * The largest proxy envelope the gateway will read, chosen rather than inherited.
 *
 * Fastify's default is 1 MB, which is both smaller than an occasional legitimate payload and,
 * more to the point, enforced by the framework before any of this code runs. 8 MiB sits far
 * above anything a REST call carries and far below the mission byte budgets in the seed, so
 * what normally refuses an oversized request is the mission's own limit — this is the backstop
 * that stops a caller making the gateway buffer and hash something unbounded in memory.
 */
export const PROXY_BODY_LIMIT_BYTES = 8 * 1024 * 1024;

/** Fastify's own code for a payload that ran past `bodyLimit` while it was being read. */
const BODY_TOO_LARGE = 'FST_ERR_CTP_BODY_TOO_LARGE';

/** A body a 204 or a 304 must not carry, and that `reply.send` would otherwise re-add. */
function hasNoBody(status: number): boolean {
  return status === 204 || status === 304 || (status >= 100 && status < 200);
}

/** One way out of this route, whichever path produced the outcome. */
function respond(
  request: FastifyRequest,
  reply: FastifyReply,
  outcome: ProxyOutcome,
): FastifyReply {
  // One line per attempt, matching the audit row it was written next to: the trail is for
  // reading later, the log is for watching now. Neither carries a header or a body.
  request.log.info(
    { decision: outcome.decision, reason: outcome.reason, status: outcome.status },
    'proxy attempt',
  );

  // The one header the gateway adds to an upstream response: it is what ties what the agent
  // got to the audit row explaining why it got it.
  void reply
    .code(outcome.status)
    .headers(outcome.headers)
    .header('x-agentgate-request-id', outcome.requestId);

  return hasNoBody(outcome.status) ? reply.send() : reply.send(outcome.body);
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

    // A body past the limit is the one envelope the parser above never gets to see: Fastify
    // stops reading and throws while the request is still being received. Left alone it becomes
    // a framework error — no decision, no audit row, no slot — so it is caught here and sent
    // back through the pipeline, which charges and records it like any other refused attempt.
    // Scoped to this plugin: the enforcement tree answers for its own routes (D11).
    app.setErrorHandler(async (error: FastifyError, request, reply) => {
      if (error.code !== BODY_TOO_LARGE) {
        throw error;
      }

      // The token travels in a header, so the caller is still identifiable even though the body
      // never arrived — which is what makes charging the right mission possible.
      return respond(
        request,
        reply,
        await handleProxyRequest(deps, request.id, request.headers.authorization, OVERSIZED_BODY),
      );
    });

    app.post('/v1/proxy', { bodyLimit: PROXY_BODY_LIMIT_BYTES }, async (request, reply) =>
      respond(
        request,
        reply,
        await handleProxyRequest(deps, request.id, request.headers.authorization, request.body),
      ),
    );
  };
}
