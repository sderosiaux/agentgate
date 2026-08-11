import { afterEach, expect, test } from 'vitest';
import { ADMIN_TOKEN, startHarness, type Harness } from './helpers/gateway.js';

const started: Harness[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map(async (harness) => harness.close()));
});

async function start(): Promise<Harness> {
  const harness = await startHarness();
  started.push(harness);

  return harness;
}

/**
 * Every route the management tree serves, read off the document it publishes rather than
 * written down here: a route added without a test is the thing this walk exists to catch, and a
 * hand-maintained list would simply not mention it.
 */
async function managementRoutes(harness: Harness): Promise<[string, string][]> {
  const document = (await harness.app.inject({ method: 'GET', url: '/api/docs/json' })).json() as {
    paths: Record<string, Record<string, unknown>>;
  };

  return Object.entries(document.paths).flatMap(([path, operations]) =>
    Object.keys(operations).map((method): [string, string] => [
      method.toUpperCase(),
      path.replaceAll('{id}', 'x').replaceAll('{requestId}', 'req_x'),
    ]),
  );
}

/** Paths that exist only as typos. Under the guard, they must be indistinguishable from real ones. */
const UNKNOWN_PATHS = [
  '/api/v1',
  '/api/v1/',
  '/api/v1/nope',
  '/api/v1/principals/extra/segments',
  '/api/v1/missions/mis_x/nope',
  '/api/v1/stats',
  '/api/v1/decisions',
];

test('every management route is refused without the admin token', async () => {
  const harness = await start();
  const routes = await managementRoutes(harness);

  // The document is what the demo and the web UI are written against: if it ever ships with no
  // paths, this walk would pass by asserting nothing.
  expect(routes.length).toBeGreaterThan(10);

  const agentToken = await harness.mint();

  for (const [method, url] of routes) {
    for (const token of [undefined, 'wrong-admin-token', '', agentToken]) {
      const response = await harness.app.inject({
        method: method as 'GET',
        url,
        ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
      });

      expect({ method, url, status: response.statusCode }).toEqual({
        method,
        url,
        status: 401,
      });
      expect(response.json()).toMatchObject({ error: 'agentgate_invalid_token' });
    }
  }
});

test('a path that does not exist under /api/v1 answers 401 too, and 404 only once authenticated', async () => {
  const harness = await start();

  for (const url of UNKNOWN_PATHS) {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      // Without the token, a typo and a real route give the same answer. Anything else is a way
      // to map the management API from outside it.
      const anonymous = await harness.app.inject({ method, url });
      expect({ method, url, status: anonymous.statusCode }).toEqual({ method, url, status: 401 });
      expect(anonymous.json()).toMatchObject({ error: 'agentgate_invalid_token' });

      const authenticated = await harness.app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect({ method, url, status: authenticated.statusCode }).toEqual({
        method,
        url,
        status: 404,
      });
      expect(authenticated.json()).toMatchObject({ error: 'agentgate_not_found' });
    }
  }
});

test('the enforcement tree is untouched by the management guard', async () => {
  const harness = await start();

  // The admin token opens the management tree and nothing else: it is not an agent token, and
  // /v1/proxy must not accept it (D11).
  const response = await harness.proxy(
    { credential: harness.alias, method: 'GET', url: 'https://api.github.com/repos/acme/payments' },
    ADMIN_TOKEN,
  );

  expect(response.statusCode).toBe(401);
  expect(harness.upstreamRequests).toHaveLength(0);
});

test('the admin token never reaches a log line, on any management route', async () => {
  const harness = await start();

  await harness.admin('GET', '/api/v1/stats/overview');
  await harness.admin('GET', '/api/v1/audit');
  await harness.admin('GET', '/api/v1/nope');
  await harness.admin('GET', '/api/v1/credentials', { token: undefined });

  expect(harness.logLines.join('\n')).not.toContain(ADMIN_TOKEN);
});
