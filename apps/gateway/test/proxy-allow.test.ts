import { paymentsIssue423, paymentsRepo } from '@agentgate/mock-github';
import { afterEach, expect, test } from 'vitest';
import { startHarness, UPSTREAM_TOKEN, type Harness } from './helpers/gateway.js';

let harness: Harness;

afterEach(async () => {
  await harness.close();
});

test('an allowed read reaches the upstream and comes back untouched', async () => {
  harness = await startHarness();
  const token = await harness.mint();

  const response = await harness.proxy(
    {
      credential: harness.alias,
      method: 'GET',
      url: 'https://api.github.com/repos/acme/payments',
    },
    token,
  );

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(paymentsRepo);
  expect(response.headers['content-type']).toMatch(/application\/json/);
});

test('the upstream is reached with the injected credential, never with the agent token', async () => {
  harness = await startHarness();
  const token = await harness.mint();

  await harness.proxy(
    {
      credential: harness.alias,
      method: 'GET',
      url: 'https://api.github.com/repos/acme/payments/issues/423',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    },
    token,
  );

  expect(harness.upstreamRequests).toHaveLength(1);
  expect(harness.upstreamRequests[0]?.authorization).toBe(`Bearer ${UPSTREAM_TOKEN}`);
  expect(harness.upstreamRequests[0]?.authorization).not.toContain(token);
});

test('an action implied by a granted one is allowed', async () => {
  // `repo.read` covers `issue.read`, so the mission does not have to list both.
  harness = await startHarness({
    permissions: {
      resources: ['github:acme/payments'],
      allowedActions: ['repo.read'],
      approvalActions: [],
      deniedActions: [],
    },
  });
  const token = await harness.mint();

  const response = await harness.proxy(
    {
      credential: harness.alias,
      method: 'GET',
      url: 'https://api.github.com/repos/acme/payments/issues/423',
    },
    token,
  );

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(paymentsIssue423);
});

test('the audit row of an allowed request names what was decided and how long it took', async () => {
  harness = await startHarness();
  const token = await harness.mint();

  const response = await harness.proxy(
    {
      credential: harness.alias,
      method: 'GET',
      url: 'https://api.github.com/repos/acme/payments',
    },
    token,
  );

  const requestId = String(response.headers['x-agentgate-request-id']);
  const rows = await harness.prisma.auditEvent.findMany({
    where: { missionId: harness.missionId },
  });

  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    decision: 'ALLOW',
    principalId: harness.principalId,
    agentId: harness.agentId,
    missionId: harness.missionId,
    resource: 'github:acme/payments',
    action: 'repo.read',
    method: 'GET',
    destHost: 'api.github.com',
    destPath: '/repos/acme/payments',
    matchedPolicy: 'mission-allowed-action',
    httpStatus: 200,
  });
  expect(rows[0]?.requestId).toMatch(/^req_/);
  expect(rows[0]?.latencyMs).toBeGreaterThanOrEqual(0);
  // What the agent got back is what an operator would search the trail with.
  expect(requestId).toBe(rows[0]?.requestId);
});

test('the request id the upstream sees is the gateway one, not the agent one', async () => {
  harness = await startHarness();
  const token = await harness.mint();

  await harness.proxy(
    {
      credential: harness.alias,
      method: 'GET',
      url: 'https://api.github.com/repos/acme/payments',
      headers: { 'x-request-id': 'req_chosen_by_the_agent' },
    },
    token,
  );

  const [row] = await harness.prisma.auditEvent.findMany({
    where: { missionId: harness.missionId },
  });

  expect(harness.upstreamRequests[0]?.requestId).not.toBe('req_chosen_by_the_agent');
  expect(harness.upstreamRequests[0]?.requestId).toBe(row?.requestId);
});

test('the query string is forwarded while policy matched the query-less path', async () => {
  harness = await startHarness();
  const token = await harness.mint();

  const response = await harness.proxy(
    {
      credential: harness.alias,
      method: 'GET',
      url: 'https://api.github.com/repos/acme/payments?state=open&per_page=5',
    },
    token,
  );

  expect(response.statusCode).toBe(200);
  expect(harness.upstreamRequests[0]?.url).toBe('/repos/acme/payments?state=open&per_page=5');

  const [row] = await harness.prisma.auditEvent.findMany({
    where: { missionId: harness.missionId },
  });
  expect(row?.destPath).toBe('/repos/acme/payments');
});

test('an upstream error status passes through with its body', async () => {
  harness = await startHarness();
  const token = await harness.mint();

  const response = await harness.proxy(
    {
      credential: harness.alias,
      // Allowed by the mission and mapped to `repo.read`, and the mock has no such repository.
      method: 'GET',
      url: 'https://api.github.com/repos/acme/payments/pulls',
    },
    token,
  );

  expect(response.statusCode).toBe(404);
  expect(response.json()).toEqual({ message: 'Not Found' });

  const [row] = await harness.prisma.auditEvent.findMany({
    where: { missionId: harness.missionId },
  });
  // The gateway allowed it; the upstream is the one that said no.
  expect(row?.decision).toBe('ALLOW');
  expect(row?.httpStatus).toBe(404);
});

test('the mission byte counter grows by the request and the response together', async () => {
  harness = await startHarness();
  const token = await harness.mint();

  const response = await harness.proxy(
    {
      credential: harness.alias,
      method: 'GET',
      url: 'https://api.github.com/repos/acme/payments',
    },
    token,
  );

  const counter = await harness.prisma.usageCounter.findUniqueOrThrow({
    where: { missionId: harness.missionId },
  });

  expect(counter.requestCount).toBe(1);
  expect(Number(counter.bytesTotal)).toBe(Buffer.byteLength(response.body, 'utf8'));
});
