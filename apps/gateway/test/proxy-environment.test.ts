import { afterEach, expect, test } from 'vitest';
import { startHarness, type Harness } from './helpers/gateway.js';

let harness: Harness;

afterEach(async () => {
  await harness.close();
});

const READ_PAYMENTS = {
  method: 'GET',
  url: 'https://api.github.com/repos/acme/payments',
} as const;

async function snapshotOf(current: Harness): Promise<Record<string, unknown>> {
  const token = await current.mint();
  const response = await current.proxy({ credential: current.alias, ...READ_PAYMENTS }, token);
  const row = await current.prisma.auditEvent.findFirstOrThrow({
    where: { requestId: String(response.headers['x-agentgate-request-id']) },
  });

  return row.policyInputSnapshot as Record<string, unknown>;
}

test('the environment a policy sees is the gateway it is running on', async () => {
  // A rule written as "no production deletes" reads `input.environment.name`. If that came from
  // the mission row, anyone who can create a mission — which is the whole point of the
  // management API — could label it `development` and walk past the rule while running against
  // production credentials. It comes from the gateway's own configuration and nowhere else.
  harness = await startHarness({ environment: 'production' });

  expect(await snapshotOf(harness)).toMatchObject({ environment: { name: 'production' } });
});

test('a mission cannot name the environment it is judged in', async () => {
  harness = await startHarness({ environment: 'production', missionLabel: 'development' });

  const snapshot = await snapshotOf(harness);

  expect(snapshot).toMatchObject({ environment: { name: 'production' } });
  // The mission keeps its own label, under a name nobody will mistake for the deployment.
  expect(snapshot['mission']).toMatchObject({ label: 'development' });
});
