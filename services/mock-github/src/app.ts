import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

export interface MockGithubOptions extends FastifyServerOptions {
  /** Bearer token every route requires. Never logged, never echoed back. */
  token: string;
}

const HEALTHZ = '/healthz';
const BEARER = /^bearer (.+)$/i;

function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');

  return a.length === b.length && timingSafeEqual(a, b);
}

export function buildMockGithub(options: MockGithubOptions): FastifyInstance {
  const { token, ...serverOptions } = options;

  if (token.length === 0) {
    throw new Error('buildMockGithub requires a non-empty token');
  }

  const app = Fastify(serverOptions);

  // Audit correlation: the gateway tags each forwarded call, the tag comes back on
  // the response so both sides of the hop can be lined up in the audit trail.
  app.addHook('onRequest', async (request, reply) => {
    const requestId = request.headers['x-request-id'];

    if (typeof requestId === 'string' && requestId.length > 0) {
      reply.header('x-request-id', requestId);
    }
  });

  app.addHook('onRequest', async (request, reply) => {
    // /healthz is infrastructure, reached by the compose healthcheck which holds no
    // credential. Every other path — including unknown ones — needs the token.
    if (request.routeOptions.url === HEALTHZ) {
      return;
    }

    const presented = BEARER.exec(request.headers.authorization ?? '')?.[1];

    if (presented === undefined || !tokenMatches(presented, token)) {
      // No credential material in this line, and no query string either: sub-plan 11
      // greps every compose log for the secret and fails the build on a hit.
      request.log.warn(
        { method: request.method, path: request.url.split('?')[0] },
        'rejected request: bad credentials',
      );

      return reply.code(401).send({ message: 'Bad credentials' });
    }
  });

  app.get(HEALTHZ, async () => ({ status: 'ok' }));

  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ message: 'Not Found' }));

  return app;
}
