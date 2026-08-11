import { afterAll, beforeAll, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildMockGithub } from '../src/app.js';
import { paymentsIssue423, PULL_REQUEST_NUMBER } from '../src/fixtures.js';

const TOKEN = 'test-github-token';
const auth = { authorization: `Bearer ${TOKEN}` };

let app: FastifyInstance;

beforeAll(async () => {
  app = buildMockGithub({ token: TOKEN });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

test('GET /repos/acme/payments returns the repository', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/repos/acme/payments',
    headers: auth,
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ full_name: 'acme/payments', private: true });
});

test('GET /repos/acme/payments/issues/423 returns the issue the demo reads', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/repos/acme/payments/issues/423',
    headers: auth,
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    number: 423,
    title: 'Payment webhook retries duplicate charges',
  });
  expect(paymentsIssue423.title).toBe('Payment webhook retries duplicate charges');
});

test('POST /repos/acme/payments/pulls creates a pull request echoing the title', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/repos/acme/payments/pulls',
    headers: auth,
    payload: { title: 'Fix duplicate charge on webhook retry', head: 'fix/retries', base: 'main' },
  });

  expect(response.statusCode).toBe(201);
  expect(response.json()).toMatchObject({
    number: PULL_REQUEST_NUMBER,
    title: 'Fix duplicate charge on webhook retry',
    html_url: 'https://github.com/acme/payments/pull/991',
  });
});

test('POST /repos/acme/payments/pulls without a title fails validation', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/repos/acme/payments/pulls',
    headers: auth,
    payload: { head: 'fix/retries', base: 'main' },
  });

  expect(response.statusCode).toBe(422);
  expect(response.json()).toEqual({ message: 'Validation Failed' });
});

test('GET /repos/acme/secret-project works: the credential can read it, only policy cannot', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/repos/acme/secret-project',
    headers: auth,
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ full_name: 'acme/secret-project' });
});

test('DELETE /repos/acme/payments works too: nothing but AgentGate stands in the way', async () => {
  const response = await app.inject({
    method: 'DELETE',
    url: '/repos/acme/payments',
    headers: auth,
  });

  expect(response.statusCode).toBe(204);
  expect(response.body).toBe('');
});

test('an unknown path answers 404 even with valid credentials', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/repos/acme/payments/issues/999',
    headers: auth,
  });

  expect(response.statusCode).toBe(404);
  expect(response.json()).toEqual({ message: 'Not Found' });
});

test('an unsupported method on a known path answers 404', async () => {
  const response = await app.inject({
    method: 'PATCH',
    url: '/repos/acme/payments',
    headers: auth,
    payload: { description: 'hijacked' },
  });

  expect(response.statusCode).toBe(404);
  expect(response.json()).toEqual({ message: 'Not Found' });
});

test('x-request-id is echoed back on a successful call', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/repos/acme/payments/issues/423',
    headers: { ...auth, 'x-request-id': 'req_01j9allowed' },
  });

  expect(response.statusCode).toBe(200);
  expect(response.headers['x-request-id']).toBe('req_01j9allowed');
});
