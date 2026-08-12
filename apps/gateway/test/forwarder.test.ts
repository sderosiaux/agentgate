import { buildMockGithub, paymentsRepo } from '@agentgate/mock-github';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  buildUpstreamHeaders,
  forward,
  upstreamTarget,
  type ForwardResult,
  type UpstreamResponseTooLarge,
} from '../src/enforcement/forwarder.js';
import { MIN_SENSITIVE_LENGTH, scrubSensitive } from '../src/logging.js';
import { applyInjection } from '../src/secrets/index.js';
import { startEchoUpstream, type EchoUpstream } from './helpers/echo-upstream.js';

const UPSTREAM_TOKEN = 'forwarder-upstream-token';
const INJECTION = { type: 'header', name: 'Authorization', format: 'Bearer {value}' } as const;
const injected = applyInjection(INJECTION, UPSTREAM_TOKEN);

/**
 * Shorter than {@link MIN_SENSITIVE_LENGTH}, so the process-wide scrubber refuses to learn it —
 * and it is still a credential the agent must never see coming back.
 */
const SHORT_TOKEN = '9Vt2q';

let echo: EchoUpstream;
let github: FastifyInstance;
let githubBaseUrl: string;

beforeAll(async () => {
  echo = await startEchoUpstream();

  github = buildMockGithub({ token: UPSTREAM_TOKEN });
  await github.listen({ port: 0, host: '127.0.0.1' });
  const address = github.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('mock github did not bind a tcp port');
  }
  githubBaseUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await echo.close();
  await github.close();
});

function toEcho(overrides: Partial<Parameters<typeof forward>[0]> = {}): Promise<ForwardResult> {
  return forward({
    method: 'GET',
    url: 'https://api.github.com/repos/acme/payments',
    upstreamBaseUrl: echo.baseUrl,
    headers: undefined,
    body: undefined,
    injected,
    requestId: 'req_forwarder_test',
    maxResponseBytes: 1024 * 1024,
    ...overrides,
  });
}

test('the logical url resolves onto the physical upstream, path and query verbatim', () => {
  expect(
    upstreamTarget('http://mock-github:3001', 'https://api.github.com/repos/acme/payments'),
  ).toBe('http://mock-github:3001/repos/acme/payments');

  expect(
    upstreamTarget('http://mock-github:3001/', 'https://api.github.com/repos/a/b?state=open&per=5'),
  ).toBe('http://mock-github:3001/repos/a/b?state=open&per=5');

  // Percent escapes are not decoded and re-encoded: the upstream reads the bytes the agent wrote.
  expect(upstreamTarget('http://up:1', 'https://api.github.com/repos/a/b%2Ec?q=%20x')).toBe(
    'http://up:1/repos/a/b%2Ec?q=%20x',
  );
});

test('a url with no path still addresses the root', () => {
  expect(upstreamTarget('http://up:1', 'https://api.github.com')).toBe('http://up:1/');
  expect(upstreamTarget('http://up:1', 'https://api.github.com?page=2')).toBe(
    'http://up:1/?page=2',
  );
});

test('a fragment never reaches the wire', () => {
  expect(upstreamTarget('http://up:1', 'https://api.github.com/repos/a/b#anchor')).toBe(
    'http://up:1/repos/a/b',
  );
});

test('only allowlisted agent headers travel, and the injection is written last', () => {
  const headers = buildUpstreamHeaders(
    {
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      Authorization: 'Bearer the-agents-own-jwt',
      Connection: 'keep-alive',
      'Transfer-Encoding': 'chunked',
      Host: 'evil.example.com',
      Cookie: 'session=1',
      'X-Forwarded-For': '10.0.0.1',
      'x-request-id': 'req_chosen_by_the_agent',
    },
    injected,
    'req_minted_by_the_gateway',
  );

  expect(headers).toEqual({
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'x-request-id': 'req_minted_by_the_gateway',
    authorization: `Bearer ${UPSTREAM_TOKEN}`,
  });
});

test('an agent cannot shadow the injected header by spelling it differently', () => {
  const headers = buildUpstreamHeaders(
    { AUTHORIZATION: 'Bearer stolen' },
    injected,
    'req_minted_by_the_gateway',
  );

  expect(headers['authorization']).toBe(`Bearer ${UPSTREAM_TOKEN}`);
  expect(Object.keys(headers).filter((key) => key.toLowerCase() === 'authorization')).toHaveLength(
    1,
  );
});

test('the query string reaches the upstream intact', async () => {
  await toEcho({ url: 'https://api.github.com/repos/acme/payments/pulls?state=open&per_page=5' });

  expect(echo.received.at(-1)?.url).toBe('/repos/acme/payments/pulls?state=open&per_page=5');
});

test('the agent authorization header never reaches the upstream', async () => {
  await toEcho({ headers: { Authorization: 'Bearer the-agents-own-jwt', Cookie: 'session=1' } });

  const seen = echo.received.at(-1);
  expect(seen?.headers['authorization']).toBe(`Bearer ${UPSTREAM_TOKEN}`);
  expect(seen?.headers['cookie']).toBeUndefined();
});

test('the gateway request id is the one the upstream sees', async () => {
  await toEcho({ headers: { 'x-request-id': 'req_chosen_by_the_agent' }, requestId: 'req_minted' });

  expect(echo.received.at(-1)?.headers['x-request-id']).toBe('req_minted');
});

test('a body travels byte for byte', async () => {
  await toEcho({
    method: 'POST',
    url: 'https://api.github.com/repos/acme/payments/pulls',
    headers: { 'Content-Type': 'application/json' },
    body: '{"title":"Fix duplicate charges","body":"héllo · $& \\\\"}',
  });

  expect(echo.received.at(-1)?.body).toBe(
    '{"title":"Fix duplicate charges","body":"héllo · $& \\\\"}',
  );
});

test('a GET carries no body even when one is handed in', async () => {
  await toEcho({ body: 'ignored' });

  expect(echo.received.at(-1)?.body ?? '').toBe('');
});

test('response headers outside the safelist are dropped', async () => {
  const result = await toEcho();

  expect(result.headers['content-type']).toMatch(/application\/json/);
  expect(result.headers['set-cookie']).toBeUndefined();
  expect(result.headers['x-secret-upstream-header']).toBeUndefined();
});

test('an upstream reflecting the credential back does not hand it to the agent', async () => {
  const result = await toEcho();

  // The upstream echoes every header it received, including the one the gateway injected.
  // Passing that through would defeat the entire point: the agent would end up holding the
  // credential it was never allowed to see.
  expect(result.body).not.toContain(UPSTREAM_TOKEN);
  expect(result.body).toContain('[REDACTED]');
});

test('a credential reflected into a response header does not reach the agent either', async () => {
  const result = await toEcho();

  expect(result.headers['etag']).not.toContain(UPSTREAM_TOKEN);
  expect(result.headers['etag']).toContain('[REDACTED]');
});

test('a credential reflected without its scheme is caught too', async () => {
  // What is registered is the credential, not the header it rides in, so an upstream that
  // strips `Bearer ` and hands back the bare value gains nothing by it.
  const result = await toEcho();

  expect(JSON.parse(result.body)['bare']).toBe('[REDACTED]');
  expect(result.headers['link']).toBe('[REDACTED]');
});

test('a credential too short for the global scrubber is still kept out of the response', async () => {
  // The threshold protecting the logs is not a statement about which credentials deserve to be
  // hidden from the agent: this one is five characters long, the upstream hands it straight
  // back, and the whole gateway exists so that the agent never holds it.
  expect(SHORT_TOKEN.length).toBeLessThan(MIN_SENSITIVE_LENGTH);

  const result = await toEcho({ injected: applyInjection(INJECTION, SHORT_TOKEN) });
  const body = JSON.parse(result.body) as { headers: Record<string, string>; bare: string };

  // Both spellings: the header as composed, and the bare value an upstream that strips the
  // scheme reflects.
  expect(result.body).not.toContain(SHORT_TOKEN);
  expect(body.headers['authorization']).toBe('[REDACTED]');
  expect(body.bare).toBe('[REDACTED]');

  // Still counted before scrubbing, and here the arithmetic runs the other way: `[REDACTED]` is
  // longer than a five-character secret, so the body handed to the agent is bigger than what
  // crossed the network. The mission is charged for the network.
  expect(result.responseBytes).toBeLessThan(Buffer.byteLength(result.body, 'utf8'));
});

test('a short credential reflected into a response header does not reach the agent either', async () => {
  const result = await toEcho({ injected: applyInjection(INJECTION, SHORT_TOKEN) });

  expect(result.headers['etag']).toBe('[REDACTED]');
  expect(result.headers['link']).toBe('[REDACTED]');
});

test('a short credential injected bare, with no scheme around it, is scrubbed too', async () => {
  // `format` is exactly `{value}`, so the composed header and the credential are the same
  // string — the case the reviewer named, and the one where a scrub keyed on the composed
  // form alone would have nothing longer to match.
  const result = await toEcho({
    injected: applyInjection({ type: 'header', name: 'X-Api-Key', format: '{value}' }, SHORT_TOKEN),
  });
  const body = JSON.parse(result.body) as { headers: Record<string, string> };

  expect(result.body).not.toContain(SHORT_TOKEN);
  expect(body.headers['x-api-key']).toBe('[REDACTED]');
});

test('scrubbing one response does not teach the global scrubber a short value', async () => {
  // The per-request denylist is scoped to the request that injected the credential. Registering
  // a five-character string process-wide would redact it out of every unrelated log line, which
  // is exactly what MIN_SENSITIVE_LENGTH is there to prevent.
  await toEcho({ injected: applyInjection(INJECTION, SHORT_TOKEN) });

  expect(scrubSensitive(`an unrelated line mentioning ${SHORT_TOKEN} stays intact`)).toBe(
    `an unrelated line mentioning ${SHORT_TOKEN} stays intact`,
  );
});

test('the bytes charged to the mission are the bytes the upstream actually sent', async () => {
  // Scrubbing shortens the body; the network moved the original, and that is what a byte
  // budget is about.
  const result = await toEcho();

  expect(result.responseBytes).toBeGreaterThan(Buffer.byteLength(result.body, 'utf8'));
});

test('a response larger than the caller allows is refused instead of buffered', async () => {
  const failure = await toEcho({
    url: 'https://api.github.com/repos/acme/payments?bytes=20000',
    maxResponseBytes: 4_096,
  }).catch((error: unknown) => error);

  expect(failure).toMatchObject({ code: 'agentgate_upstream_error', httpStatus: 502 });
  // What was read before the gateway stopped reading, so the mission can be charged for it.
  expect((failure as UpstreamResponseTooLarge).bytesRead).toBeGreaterThan(0);
  expect((failure as Error).message).toMatch(/larger than/i);
});

test('a response inside the allowance comes back whole', async () => {
  const result = await toEcho({
    url: 'https://api.github.com/repos/acme/payments?bytes=4000',
    maxResponseBytes: 8_192,
  });

  expect(result.status).toBe(200);
  expect(result.responseBytes).toBe(4_000);
});

test('a body that is not text does not survive the forward, and that is the contract', async () => {
  // Characterisation, not an endorsement: `forward` decodes utf-8, so binary bytes come back
  // as U+FFFD. Nothing reachable produces them — a request only gets here once an adapter has
  // mapped it, and every adapter maps a JSON API (D4). The day one does not, this test fails
  // and whoever wrote it has to decide what the forwarder should do instead.
  const result = await toEcho({ url: 'https://api.github.com/binary' });

  expect(result.responseBytes).toBe(8);
  expect(Buffer.from(result.body, 'utf8')).not.toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  expect(result.body).toContain('�');
});

test('the injected credential is what makes the upstream answer', async () => {
  const result = await forward({
    method: 'GET',
    url: 'https://api.github.com/repos/acme/payments',
    upstreamBaseUrl: githubBaseUrl,
    headers: { Authorization: 'Bearer the-agents-own-jwt' },
    body: undefined,
    injected,
    requestId: 'req_forwarder_injection',
    maxResponseBytes: 1024 * 1024,
  });

  expect(result.status).toBe(200);
  expect(JSON.parse(result.body)).toEqual(paymentsRepo);
  expect(result.responseBytes).toBe(Buffer.byteLength(result.body, 'utf8'));
});

test('a wrong credential comes back as the upstream 401, not as a gateway failure', async () => {
  const result = await forward({
    method: 'GET',
    url: 'https://api.github.com/repos/acme/payments',
    upstreamBaseUrl: githubBaseUrl,
    headers: undefined,
    body: undefined,
    injected: applyInjection(INJECTION, 'not-the-upstream-token'),
    requestId: 'req_forwarder_wrong_token',
    maxResponseBytes: 1024 * 1024,
  });

  expect(result.status).toBe(401);
  expect(JSON.parse(result.body)).toEqual({ message: 'Bad credentials' });
});

test('an upstream 404 passes through with its body', async () => {
  const result = await forward({
    method: 'GET',
    url: 'https://api.github.com/repos/acme/nothing-here',
    upstreamBaseUrl: githubBaseUrl,
    headers: undefined,
    body: undefined,
    injected,
    requestId: 'req_forwarder_404',
    maxResponseBytes: 1024 * 1024,
  });

  expect(result.status).toBe(404);
  expect(JSON.parse(result.body)).toEqual({ message: 'Not Found' });
});

test('an unreachable upstream is a 502 that names no address', async () => {
  const failure = await forward({
    method: 'GET',
    url: 'https://api.github.com/repos/acme/payments',
    // Port 1 on the loopback: nothing listens, and the connection is refused immediately.
    upstreamBaseUrl: 'http://127.0.0.1:1',
    headers: undefined,
    body: undefined,
    injected,
    requestId: 'req_forwarder_unreachable',
    maxResponseBytes: 1024 * 1024,
  }).catch((error: unknown) => error);

  expect(failure).toMatchObject({ code: 'agentgate_upstream_error', httpStatus: 502 });
  expect((failure as Error).message).not.toContain('127.0.0.1');
});

test('an upstream slower than the timeout is a 502', async () => {
  const failure = await toEcho({ timeoutMs: 50, url: 'https://api.github.com/slow' }).catch(
    (error: unknown) => error,
  );

  expect(failure).toMatchObject({ code: 'agentgate_upstream_error', httpStatus: 502 });
});
