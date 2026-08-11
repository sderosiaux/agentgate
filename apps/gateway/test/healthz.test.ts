import { afterAll, beforeAll, expect, test } from 'vitest';
import { startHarness, type Harness } from './helpers/gateway.js';

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness();
});

afterAll(async () => {
  await harness.close();
});

test('GET /healthz returns 200 with status ok', async () => {
  const response = await harness.app.inject({ method: 'GET', url: '/healthz' });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ status: 'ok' });
});

test('an unknown route answers with an AgentGate error body', async () => {
  const response = await harness.app.inject({ method: 'GET', url: '/nope' });

  expect(response.statusCode).toBe(404);
  expect(response.json()).toMatchObject({ error: 'agentgate_not_found' });
  expect(String(response.json()['request_id'])).toMatch(/^req_/);
});
