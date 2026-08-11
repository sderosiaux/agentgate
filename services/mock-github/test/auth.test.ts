import { afterEach, beforeEach, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildMockGithub } from '../src/app.js';

const TOKEN = 'test-github-token';

let app: FastifyInstance;

beforeEach(async () => {
  app = buildMockGithub({ token: TOKEN });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

test('a request without an Authorization header is rejected the GitHub way', async () => {
  const response = await app.inject({ method: 'GET', url: '/repos/acme/payments' });

  expect(response.statusCode).toBe(401);
  expect(response.json()).toEqual({ message: 'Bad credentials' });
});

test('a request with the wrong bearer token is rejected', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/repos/acme/payments',
    headers: { authorization: 'Bearer not-the-github-token' },
  });

  expect(response.statusCode).toBe(401);
  expect(response.json()).toEqual({ message: 'Bad credentials' });
});

test('a token presented under another scheme is rejected', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/repos/acme/payments',
    headers: { authorization: `Basic ${TOKEN}` },
  });

  expect(response.statusCode).toBe(401);
});

test('the guard runs before routing, so unknown routes answer 401 without credentials', async () => {
  const response = await app.inject({ method: 'GET', url: '/repos/acme/unknown' });

  expect(response.statusCode).toBe(401);
  expect(response.json()).toEqual({ message: 'Bad credentials' });
});

test('a 401 still echoes x-request-id, so the gateway can correlate its audit trail', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/repos/acme/payments',
    headers: { 'x-request-id': 'req_denied_42' },
  });

  expect(response.statusCode).toBe(401);
  expect(response.headers['x-request-id']).toBe('req_denied_42');
});

test('/healthz answers without credentials: it is infrastructure, not a repo route', async () => {
  const response = await app.inject({ method: 'GET', url: '/healthz' });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ status: 'ok' });
});

test('building the service without a token is a programming error', () => {
  expect(() => buildMockGithub({ token: '' })).toThrow(/token/i);
});

function buildWithCapturedLogs(): { app: FastifyInstance; lines: string[] } {
  const lines: string[] = [];
  const app = buildMockGithub({
    token: TOKEN,
    logger: {
      level: 'trace',
      stream: {
        write(chunk: string) {
          lines.push(chunk);
        },
      },
    },
  });

  return { app, lines };
}

test('nothing about the credentials reaches the logs on an auth failure', async () => {
  const presented = 'presented-token-abcdef';
  const { app: logged, lines } = buildWithCapturedLogs();
  await logged.ready();

  const response = await logged.inject({
    method: 'GET',
    url: '/repos/acme/payments',
    headers: { authorization: `Bearer ${presented}` },
  });
  await logged.close();

  expect(response.statusCode).toBe(401);
  // The log must exist (the denial is worth recording) but carry neither the secret
  // the service expects nor the value the caller tried.
  expect(lines.length).toBeGreaterThan(0);
  const output = lines.join('');
  expect(output).not.toContain(TOKEN);
  expect(output).not.toContain(presented);
});

test('a token smuggled into the query string never reaches the logs either', async () => {
  const { app: logged, lines } = buildWithCapturedLogs();
  await logged.ready();

  const response = await logged.inject({
    method: 'GET',
    url: `/repos/acme/payments?access_token=${TOKEN}`,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  await logged.close();

  expect(response.statusCode).toBe(200);
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.join('')).not.toContain(TOKEN);
});
