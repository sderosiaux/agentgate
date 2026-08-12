import { afterEach, expect, test } from 'vitest';
import type { AuditEventInput, AuditRecorder } from '../src/audit/recorder.js';
import { startHarness, type Harness } from './helpers/gateway.js';

let harness: Harness;

afterEach(async () => {
  await harness.close();
});

const READ_PAYMENTS = {
  method: 'GET',
  url: 'https://api.github.com/repos/acme/payments',
} as const;

/**
 * An audit table that has stopped accepting rows: a full disk, a lock, a migration halfway
 * through. Everything else about the gateway still works, which is what makes this the awkward
 * failure — the upstream is reachable and does what it is told.
 */
function brokenAudit(real: AuditRecorder, failWhen: (event: AuditEventInput) => boolean) {
  return {
    async record(event: AuditEventInput): Promise<void> {
      if (failWhen(event)) {
        throw new Error('the audit table is not accepting writes');
      }

      await real.record(event);
    },
  };
}

test('nothing is forwarded before the intent to forward it is durable', async () => {
  // The reviewer's scenario. The upstream performs the side effect, the audit write then fails,
  // the caller gets a 500 and retries — and without a record of the first attempt, nothing in
  // the system knows the side effect already happened.
  harness = await startHarness({
    audit: (real) => brokenAudit(real, (event) => event.decision === 'ALLOW'),
  });
  const token = await harness.mint();

  const response = await harness.proxy({ credential: harness.alias, ...READ_PAYMENTS }, token);

  // The side effect happened and the trail lost it: that is the window, and it is still there.
  // The agent is not even handed a request id — the route never gets to add the header, because
  // the throw comes from the `finally` that was supposed to write the row.
  expect(response.statusCode).toBe(500);
  expect(harness.upstreamRequests).toHaveLength(1);
  expect(response.headers['x-agentgate-request-id']).toBeUndefined();
  expect(await harness.prisma.auditEvent.count({ where: { missionId: harness.missionId } })).toBe(
    0,
  );

  // What closes it: a row written before the request left, which the failing table cannot
  // swallow because it is not that table. The request id is on it, so the agent's retry and the
  // attempt it is repeating can still be tied together.
  const intent = await harness.prisma.forwardIntent.findFirstOrThrow({
    where: { missionId: harness.missionId },
  });
  expect(intent.requestId).toMatch(/^req_/);
  expect(intent).toMatchObject({
    missionId: harness.missionId,
    agentId: harness.agentId,
    principalId: harness.principalId,
    method: 'GET',
    destHost: 'api.github.com',
    destPath: '/repos/acme/payments',
    resource: 'github:acme/payments',
    action: 'repo.read',
    credentialAlias: harness.alias,
  });
});

test('an intent that cannot be written stops the request before the upstream sees it', async () => {
  // The other direction, and the whole point of writing it first: if the record cannot be made
  // durable, the side effect must not happen either.
  harness = await startHarness();
  const token = await harness.mint();

  await harness.prisma
    .$executeRaw`ALTER TABLE "ForwardIntent" ADD CONSTRAINT "temporarily_impossible" CHECK (false) NOT VALID`;

  try {
    const response = await harness.proxy({ credential: harness.alias, ...READ_PAYMENTS }, token);

    expect(response.statusCode).toBe(500);
    expect(harness.upstreamRequests).toHaveLength(0);
  } finally {
    await harness.prisma
      .$executeRaw`ALTER TABLE "ForwardIntent" DROP CONSTRAINT "temporarily_impossible"`;
  }
});

test('an allowed request leaves an intent and the outcome that followed it', async () => {
  harness = await startHarness();
  const token = await harness.mint();

  const response = await harness.proxy({ credential: harness.alias, ...READ_PAYMENTS }, token);
  const requestId = String(response.headers['x-agentgate-request-id']);

  expect(response.statusCode).toBe(200);
  // Still exactly one audit row per attempt: the intent lives in its own table precisely so
  // that invariant does not have to bend.
  expect(await harness.prisma.auditEvent.count({ where: { requestId } })).toBe(1);
  expect(await harness.prisma.forwardIntent.count({ where: { requestId } })).toBe(1);
});

test('a request that never reaches an upstream records no intent to reach one', async () => {
  harness = await startHarness();
  const token = await harness.mint();

  // Denied by the mission scope, so nothing was ever going to be sent.
  await harness.proxy(
    { credential: harness.alias, method: 'GET', url: 'https://api.github.com/repos/acme/other' },
    token,
  );
  // Gated behind a human, which is a decision and not an attempt.
  await harness.proxy(
    {
      credential: harness.alias,
      method: 'POST',
      url: 'https://api.github.com/repos/acme/payments/pulls',
      headers: { 'Content-Type': 'application/json' },
      body: '{"title":"Fix duplicate charges"}',
    },
    token,
  );

  expect(
    await harness.prisma.forwardIntent.count({ where: { missionId: harness.missionId } }),
  ).toBe(0);
});

test('an intent names the grant that was spent, so a lost outcome is traceable to it', async () => {
  // The case that hurts most: a one-time approval consumed, the upstream acted on it, and the
  // outcome never recorded. Whoever picks this up has to be able to tie the two together.
  harness = await startHarness({
    audit: (real) => brokenAudit(real, (event) => event.decision === 'ALLOW'),
  });
  const token = await harness.mint();

  const gated = await harness.proxy(
    {
      credential: harness.alias,
      method: 'POST',
      url: 'https://api.github.com/repos/acme/payments/pulls',
      headers: { 'Content-Type': 'application/json' },
      body: '{"title":"Fix duplicate charges"}',
    },
    token,
  );
  const approvalId = String(gated.json()['approval_id']);
  await harness.admin('POST', `/api/v1/approvals/${approvalId}/approve`);

  const retry = await harness.proxy(
    {
      credential: harness.alias,
      method: 'POST',
      url: 'https://api.github.com/repos/acme/payments/pulls',
      headers: { 'Content-Type': 'application/json' },
      body: '{"title":"Fix duplicate charges"}',
      approvalId,
    },
    token,
  );

  expect(retry.statusCode).toBe(500);
  const intent = await harness.prisma.forwardIntent.findFirstOrThrow({
    where: { missionId: harness.missionId },
  });
  expect(intent).toMatchObject({ approvalId, action: 'pull_request.create' });
  expect(intent.bodyHash).toMatch(/^[0-9a-f]{64}$/);
});
