import { timingSafeEqual } from 'node:crypto';
import Fastify, {
  LogController,
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import {
  createdPullRequest,
  paymentsIssue423,
  paymentsRepo,
  secretProjectRepo,
} from './fixtures.js';

// The package entry point is app.ts, so the fixtures travel with it: the gateway
// integration tests assert against these exact payloads.
export * from './fixtures.js';

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

/** Everything before the query string, which is the only part safe to log. */
function pathOf(url: string): string {
  return url.split('?')[0] ?? url;
}

export function buildMockGithub(options: MockGithubOptions): FastifyInstance {
  const { token, ...serverOptions } = options;

  if (token.length === 0) {
    throw new Error('buildMockGithub requires a non-empty token');
  }

  const app = Fastify({
    ...serverOptions,
    // Fastify's built-in request logs print the raw url, so a token smuggled into a
    // query string would land in the compose logs sub-plan 11 greps. We log our own
    // line with the query string dropped instead.
    logController: new LogController({ disableRequestLogging: true }),
  });

  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      { method: request.method, path: pathOf(request.url), statusCode: reply.statusCode },
      'request completed',
    );
  });

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
        { method: request.method, path: pathOf(request.url) },
        'rejected request: bad credentials',
      );

      return reply.code(401).send({ message: 'Bad credentials' });
    }
  });

  app.get(HEALTHZ, async () => ({ status: 'ok' }));

  app.get('/repos/acme/payments', async () => paymentsRepo);

  app.get('/repos/acme/payments/issues/423', async () => paymentsIssue423);

  app.post('/repos/acme/payments/pulls', async (request, reply) => {
    const body = request.body as { title?: unknown } | null;
    const title = typeof body?.title === 'string' ? body.title.trim() : '';

    if (title.length === 0) {
      return reply.code(422).send({ message: 'Validation Failed' });
    }

    return reply.code(201).send(createdPullRequest(title));
  });

  // Both routes below succeed on purpose: the credential is allowed to read the
  // secret repository and to delete the payments one. The demo denies them at the
  // gateway, showing that the limits come from policy rather than from the token.
  app.get('/repos/acme/secret-project', async () => secretProjectRepo);

  app.delete('/repos/acme/payments', async (_request, reply) => reply.code(204).send());

  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ message: 'Not Found' }));

  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;

    // A malformed body is the caller's problem and its own status code says so;
    // flattening it into a 500 would just make the demo harder to read.
    if (statusCode < 500) {
      return reply.code(statusCode).send({ message: error.message });
    }

    // `err` only: the request carries the credential, and the default handler
    // would otherwise return the raw failure to a caller who must learn nothing
    // about this service's internals.
    request.log.error({ err: error }, 'request failed');

    return reply.code(500).send({ message: 'Internal Server Error' });
  });

  return app;
}
