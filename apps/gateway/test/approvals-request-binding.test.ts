import { afterEach, expect, test } from 'vitest';
import { startHarness, type Harness } from './helpers/gateway.js';

const started: Harness[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map(async (harness) => harness.close()));
});

async function start(): Promise<Harness> {
  const harness = await startHarness({
    network: {
      allow: [
        { host: 'api.github.com', path: '/repos/acme/payments/pulls/**', methods: ['PUT'] },
        { host: 'api.github.com', path: '/repos/acme/payments/pulls', methods: ['POST'] },
      ],
      deny: [],
    },
    permissions: {
      resources: ['github:acme/payments'],
      allowedActions: [],
      approvalActions: ['pull_request.merge', 'pull_request.create'],
      deniedActions: [],
    },
  });
  started.push(harness);

  return harness;
}

function merge(harness: Harness, pull: number, approvalId?: string) {
  return {
    credential: harness.alias,
    method: 'PUT' as const,
    url: `https://api.github.com/repos/acme/payments/pulls/${String(pull)}/merge`,
    ...(approvalId === undefined ? {} : { approvalId }),
  };
}

function open(harness: Harness, title: string, approvalId?: string) {
  return {
    credential: harness.alias,
    method: 'POST' as const,
    url: 'https://api.github.com/repos/acme/payments/pulls',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
    ...(approvalId === undefined ? {} : { approvalId }),
  };
}

async function approve(harness: Harness, approvalId: string): Promise<void> {
  const decision = await harness.admin('POST', `/api/v1/approvals/${approvalId}/approve`);
  expect(decision.statusCode).toBe(200);
}

test('a grant for one pull request does not merge another', async () => {
  // The substitution the whole mechanism exists to stop: the human is shown pull request 7 and
  // clicks approve; the agent comes back with the same grant and pull request 9. Same mission,
  // same agent, same resource, same action — a different request.
  const harness = await start();
  const token = await harness.mint();

  const asked = await harness.proxy(merge(harness, 7), token);
  expect(asked.statusCode).toBe(202);
  const approvalId = String(asked.json()['approval_id']);
  await approve(harness, approvalId);

  const substituted = await harness.proxy(merge(harness, 9, approvalId), token);

  expect(substituted.statusCode).toBe(403);
  expect(substituted.json()).toMatchObject({
    reason: `approval ${approvalId} does not authorise this request`,
  });
  expect(harness.upstreamRequests).toHaveLength(0);

  // Still spendable on the request it was actually issued for: the grant is consumed and the
  // request reaches the upstream. What the mock GitHub answers to a merge is its business.
  await harness.proxy(merge(harness, 7, approvalId), token);
  expect(harness.upstreamRequests).toHaveLength(1);
  expect(
    (await harness.prisma.approval.findUniqueOrThrow({ where: { id: approvalId } })).status,
  ).toBe('consumed');
});

test('a grant for one body does not authorise another', async () => {
  const harness = await start();
  const token = await harness.mint();

  const asked = await harness.proxy(open(harness, 'Fix duplicate charges'), token);
  const approvalId = String(asked.json()['approval_id']);
  await approve(harness, approvalId);

  const substituted = await harness.proxy(open(harness, 'Ship everything', approvalId), token);

  expect(substituted.statusCode).toBe(403);
  expect(harness.upstreamRequests).toHaveLength(0);
});

test('a grant does not survive a change of method', async () => {
  const harness = await start();
  const token = await harness.mint();

  const asked = await harness.proxy(merge(harness, 7), token);
  const approvalId = String(asked.json()['approval_id']);
  await approve(harness, approvalId);

  const substituted = await harness.proxy(
    {
      credential: harness.alias,
      method: 'POST',
      url: 'https://api.github.com/repos/acme/payments/pulls',
      headers: { 'Content-Type': 'application/json' },
      body: '{"title":"anything"}',
      approvalId,
    },
    token,
  );

  expect(substituted.statusCode).toBe(403);
  expect(harness.upstreamRequests).toHaveLength(0);
});

test('two different pull requests are two different questions for a human', async () => {
  // The other half of the binding: if a grant is pinned to one request, the idempotent-pending
  // lookup has to be pinned to the same thing, or the second request would silently join the
  // first one's approval and inherit a decision nobody made about it.
  const harness = await start();
  const token = await harness.mint();

  const seven = await harness.proxy(merge(harness, 7), token);
  const nine = await harness.proxy(merge(harness, 9), token);

  expect([seven.statusCode, nine.statusCode]).toEqual([202, 202]);
  expect(seven.json()['approval_id']).not.toBe(nine.json()['approval_id']);
  expect(await harness.prisma.approval.count({ where: { missionId: harness.missionId } })).toBe(2);
});

test('the same request twice still asks a human once', async () => {
  const harness = await start();
  const token = await harness.mint();

  const first = await harness.proxy(merge(harness, 7), token);
  const second = await harness.proxy(merge(harness, 7), token);

  expect(second.json()['approval_id']).toBe(first.json()['approval_id']);
  expect(await harness.prisma.approval.count({ where: { missionId: harness.missionId } })).toBe(1);
});

test('a request with no body and one with an empty body are the same question', async () => {
  // Both hash to the digest of nothing, and both send nothing. Written down rather than left to
  // be discovered: the alternative is a NULL in the binding, and a NULL never equals itself.
  const harness = await start();
  const token = await harness.mint();

  const withoutBody = await harness.proxy(
    {
      credential: harness.alias,
      method: 'POST',
      url: 'https://api.github.com/repos/acme/payments/pulls',
    },
    token,
  );
  const withEmptyBody = await harness.proxy(
    {
      credential: harness.alias,
      method: 'POST',
      url: 'https://api.github.com/repos/acme/payments/pulls',
      body: '',
    },
    token,
  );

  expect(withEmptyBody.json()['approval_id']).toBe(withoutBody.json()['approval_id']);
});

test('the record shows the human the body hash the grant is pinned to', async () => {
  const harness = await start();
  const token = await harness.mint();

  const asked = await harness.proxy(open(harness, 'Fix duplicate charges'), token);
  const approval = await harness.prisma.approval.findUniqueOrThrow({
    where: { id: String(asked.json()['approval_id']) },
  });

  expect(approval.requestSummary).toMatchObject({
    method: 'POST',
    host: 'api.github.com',
    path: '/repos/acme/payments/pulls',
    bodyHash: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
});
