import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { startHarness, type Harness } from './helpers/gateway.js';

const started: Harness[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map(async (harness) => harness.close()));
});

async function start(): Promise<Harness> {
  const harness = await startHarness();
  started.push(harness);

  return harness;
}

interface Overview {
  activeAgents: number;
  activeMissions: number;
  requestsToday: number;
  allowedToday: number;
  deniedToday: number;
  pendingApprovals: number;
}

async function overview(harness: Harness): Promise<Overview> {
  const response = await harness.admin('GET', '/api/v1/stats/overview');
  expect(response.statusCode).toBe(200);

  return response.json() as Overview;
}

/**
 * What each counter moved by. The test database is shared with every other suite and with the
 * demo seed, so absolute numbers would be a test that passes alone and fails in CI: what this
 * plan owns is that a given fixture moves a given counter by a given amount.
 */
function delta(before: Overview, after: Overview): Overview {
  return Object.fromEntries(
    Object.entries(after).map(([key, value]) => [key, value - before[key as keyof Overview]]),
  ) as unknown as Overview;
}

test('the overview counts what happened, on the clock the gateway was given', async () => {
  const harness = await start();
  const before = await overview(harness);

  const token = await harness.mint();

  // One allowed request.
  expect(
    (
      await harness.proxy(
        {
          credential: harness.alias,
          method: 'GET',
          url: 'https://api.github.com/repos/acme/payments',
        },
        token,
      )
    ).statusCode,
  ).toBe(200);

  // One denied: an action the mission's network rules do not allow.
  expect(
    (
      await harness.proxy(
        {
          credential: harness.alias,
          method: 'GET',
          url: 'https://api.github.com/repos/acme/billing',
        },
        token,
      )
    ).statusCode,
  ).toBe(403);

  // One request waiting on a human.
  expect(
    (
      await harness.proxy(
        {
          credential: harness.alias,
          method: 'POST',
          url: 'https://api.github.com/repos/acme/payments/pulls',
          headers: { 'Content-Type': 'application/json' },
          body: '{"title":"Fix duplicate charges"}',
        },
        token,
      )
    ).statusCode,
  ).toBe(202);

  const after = await overview(harness);

  expect(delta(before, after)).toEqual({
    // The harness mission and agent were already live when the baseline was taken.
    activeAgents: 0,
    activeMissions: 0,
    requestsToday: 3,
    allowedToday: 1,
    deniedToday: 1,
    pendingApprovals: 1,
  });
});

test('a mission that is live moves the two "active" counters, and expiring it moves them back', async () => {
  const harness = await start();
  const before = await overview(harness);

  await harness.admin('POST', `/api/v1/missions/${harness.missionId}/expire`);

  const after = await overview(harness);
  expect(delta(before, after)).toMatchObject({ activeAgents: -1, activeMissions: -1 });
});

test('a mission whose deadline has passed is not counted, whatever its status column says', async () => {
  const harness = await start();
  const before = await overview(harness);

  // The row still reads `active` — nothing has touched it since the deadline went by. A
  // dashboard that trusted the column alone would keep reporting it as live all night.
  await harness.prisma.mission.update({
    where: { id: harness.missionId },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });

  const after = await overview(harness);
  expect(delta(before, after)).toMatchObject({ activeAgents: -1, activeMissions: -1 });
});

test('"today" is the clock`s UTC day, and yesterday does not count', async () => {
  const harness = await start();
  const before = await overview(harness);

  await harness.prisma.auditEvent.create({
    data: {
      id: `aud_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      requestId: `req_yesterday_${randomUUID().slice(0, 8)}`,
      timestamp: new Date(Date.now() - 25 * 60 * 60 * 1000),
      missionId: harness.missionId,
      decision: 'ALLOW',
      reason: 'seeded yesterday',
      latencyMs: 1,
    },
  });

  const after = await overview(harness);
  expect(delta(before, after)).toMatchObject({ requestsToday: 0, allowedToday: 0 });
});
