import { afterEach, expect, test } from 'vitest';
import { MAX_TOKEN_TTL_MS } from '../src/management/missions.routes.js';
import { startHarness, type Harness, type HarnessOptions } from './helpers/gateway.js';

const started: Harness[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map(async (harness) => harness.close()));
});

async function start(options: HarnessOptions = {}): Promise<Harness> {
  const harness = await startHarness(options);
  started.push(harness);

  return harness;
}

const READ_REPO = {
  method: 'GET',
  url: 'https://api.github.com/repos/acme/payments',
} as const;

async function mintFor(harness: Harness, missionId: string) {
  return harness.admin('POST', `/api/v1/missions/${missionId}/tokens`);
}

test('a token minted through the management API is a token the proxy accepts', async () => {
  const harness = await start();

  const minted = await mintFor(harness, harness.missionId);
  expect(minted.statusCode).toBe(200);

  const body = minted.json();
  expect(String(body['sessionId'])).toMatch(/^ses_/);

  const response = await harness.proxy(
    { credential: harness.alias, ...READ_REPO },
    String(body['token']),
  );

  expect(response.statusCode).toBe(200);
  expect(harness.upstreamRequests).toHaveLength(1);

  // The claims the pipeline read are the claims the mission holds (D9), including the session
  // the management API opened for this token.
  const claims = await harness.tokenService.verify(String(body['token']));
  expect(claims).toMatchObject({
    agentId: harness.agentId,
    principalId: harness.principalId,
    missionId: harness.missionId,
    agentType: 'codex',
    sessionId: String(body['sessionId']),
  });
});

test('a token never outlives its mission, and never lives longer than an hour', async () => {
  const shortMission = await start({ expiresAt: new Date(Date.now() + 5 * 60 * 1000) });
  const shortToken = await mintFor(shortMission, shortMission.missionId);
  const shortMissionRow = await shortMission.prisma.mission.findUniqueOrThrow({
    where: { id: shortMission.missionId },
  });

  // The mission is the shorter of the two, so it is the deadline.
  expect(String(shortToken.json()['expiresAt'])).toBe(shortMissionRow.expiresAt.toISOString());

  const longMission = await start({ expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });
  const longToken = await mintFor(longMission, longMission.missionId);
  const ceiling = new Date(longMission.clock.now.getTime() + MAX_TOKEN_TTL_MS).toISOString();

  // A mission that runs all day still hands out keys that are worth an hour.
  expect(String(longToken.json()['expiresAt'])).toBe(ceiling);
});

test('an expired mission mints nothing, and the row stops claiming to be active', async () => {
  const harness = await start({ expiresAt: new Date(Date.now() - 1000) });

  const refused = await mintFor(harness, harness.missionId);

  expect(refused.statusCode).toBe(409);
  expect(refused.json()).toMatchObject({ error: 'agentgate_validation_error' });
  expect(String(refused.json()['reason'])).toContain('expired');

  const mission = await harness.prisma.mission.findUniqueOrThrow({
    where: { id: harness.missionId },
  });
  expect(mission.status).toBe('expired');
});

test('a revoked mission mints nothing', async () => {
  const harness = await start({ missionStatus: 'revoked' });

  const refused = await mintFor(harness, harness.missionId);

  expect(refused.statusCode).toBe(409);
  expect(String(refused.json()['reason'])).toContain('revoked');
});

test('minting for a mission nobody created is a 404', async () => {
  const harness = await start();

  const refused = await mintFor(harness, 'mis_nobody');

  expect(refused.statusCode).toBe(404);
  expect(refused.json()).toMatchObject({ error: 'agentgate_not_found' });
});

test('SPEC demo case 6: force-expiring a mission denies the next request through the proxy', async () => {
  const harness = await start();
  const token = String((await mintFor(harness, harness.missionId)).json()['token']);

  // Before: the mission is live and the request goes through.
  expect((await harness.proxy({ credential: harness.alias, ...READ_REPO }, token)).statusCode).toBe(
    200,
  );

  const expired = await harness.admin('POST', `/api/v1/missions/${harness.missionId}/expire`);
  expect(expired.statusCode).toBe(200);
  expect(expired.json()).toMatchObject({ id: harness.missionId, status: 'expired' });

  // After: the same token, unchanged and not yet past its own expiry, no longer authorises
  // anything. The mission is what grants, not the token.
  const denied = await harness.proxy({ credential: harness.alias, ...READ_REPO }, token);

  expect(denied.statusCode).toBe(403);
  expect(denied.json()).toMatchObject({
    error: 'agentgate_mission_expired',
    decision: 'DENY',
  });
  // One request reached the upstream in this test, and it was the one before the expiry.
  expect(harness.upstreamRequests).toHaveLength(1);

  const audit = await harness.prisma.auditEvent.findFirstOrThrow({
    where: { requestId: String(denied.headers['x-agentgate-request-id']) },
  });
  expect(audit).toMatchObject({ decision: 'DENY', matchedPolicy: 'mission-expired' });

  // And no new token can be issued for it either.
  expect((await mintFor(harness, harness.missionId)).statusCode).toBe(409);
});

test('force-expiring twice is not an error: the request is "make sure this cannot be used"', async () => {
  const harness = await start();

  expect(
    (await harness.admin('POST', `/api/v1/missions/${harness.missionId}/expire`)).statusCode,
  ).toBe(200);
  expect(
    (await harness.admin('POST', `/api/v1/missions/${harness.missionId}/expire`)).statusCode,
  ).toBe(200);
});
