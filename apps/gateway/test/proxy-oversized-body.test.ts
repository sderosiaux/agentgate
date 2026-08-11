import { afterEach, expect, test } from 'vitest';
import { PROXY_BODY_LIMIT_BYTES } from '../src/enforcement/proxy.route.js';
import { startHarness, type Harness } from './helpers/gateway.js';

let harness: Harness;

afterEach(async () => {
  await harness.close();
});

/**
 * A body the gateway will not read, sent as raw text so the framework — not the test — is the
 * thing that decides it is too big.
 */
function oversizedPayload(): string {
  return JSON.stringify({
    credential: 'github_work',
    method: 'GET',
    url: 'https://api.github.com/repos/acme/payments',
    body: 'x'.repeat(PROXY_BODY_LIMIT_BYTES + 1_024),
  });
}

function post(current: Harness, token: string, payload: string) {
  return current.app.inject({
    method: 'POST',
    url: '/v1/proxy',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload,
  });
}

test('an oversized body is refused with an AgentGate error, not a framework failure', async () => {
  harness = await startHarness();
  const token = await harness.mint();

  const response = await post(harness, token, oversizedPayload());

  expect(response.statusCode).toBe(413);
  expect(response.json()).toMatchObject({
    error: 'agentgate_payload_too_large',
    decision: 'DENY',
  });
  expect(String(response.json()['request_id'])).toMatch(/^req_/);
});

test('an oversized body leaves exactly one audit row, naming the stage that refused it', async () => {
  harness = await startHarness();
  const token = await harness.mint();

  const response = await post(harness, token, oversizedPayload());

  const rows = await harness.prisma.auditEvent.findMany({
    where: { requestId: String(response.json()['request_id']) },
  });

  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    decision: 'DENY',
    httpStatus: 413,
    matchedPolicy: 'request-body-too-large',
    agentId: harness.agentId,
    missionId: harness.missionId,
  });
});

test('an oversized body costs a slot, so flooding the gateway is not free', async () => {
  harness = await startHarness();
  const token = await harness.mint();

  await post(harness, token, oversizedPayload());
  await post(harness, token, oversizedPayload());
  await post(harness, token, oversizedPayload());

  const counter = await harness.prisma.usageCounter.findUniqueOrThrow({
    where: { missionId: harness.missionId },
  });

  expect(counter.requestCount).toBe(3);
});

test('an oversized body from an unusable token is still just an unusable token', async () => {
  // Precedence holds: the caller is not identified, so there is no mission to charge and
  // nothing to say about a body nobody was going to read.
  harness = await startHarness();

  const response = await post(harness, 'not-a-token', oversizedPayload());

  expect(response.statusCode).toBe(401);
  expect(response.json()).toMatchObject({ error: 'agentgate_invalid_token' });
  expect(
    await harness.prisma.usageCounter.findUnique({ where: { missionId: harness.missionId } }),
  ).toBeNull();
});

test('an oversized body never reaches the upstream', async () => {
  harness = await startHarness();
  const token = await harness.mint();

  await post(harness, token, oversizedPayload());

  expect(harness.upstreamRequests).toHaveLength(0);
});

test('a body just under the limit is read normally', async () => {
  harness = await startHarness();
  const token = await harness.mint();

  // The envelope overhead means this is comfortably inside the limit while still being far
  // larger than anything the demo sends: the limit is a backstop, not a working constraint.
  const response = await post(
    harness,
    token,
    JSON.stringify({
      credential: harness.alias,
      method: 'GET',
      url: 'https://api.github.com/repos/acme/payments',
      body: 'x'.repeat(PROXY_BODY_LIMIT_BYTES - 4_096),
    }),
  );

  // Read, understood, and then refused on its merits — a GET carries no body upstream, and the
  // point here is that the framework did not turn it away unread.
  expect(response.statusCode).not.toBe(413);
  expect(response.statusCode).toBe(200);
});
