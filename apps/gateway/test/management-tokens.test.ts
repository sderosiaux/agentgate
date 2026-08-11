import { decodeJwt } from 'jose';
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

/** A deadline as a JWT can express it: whole seconds, never rounded up. */
function flooredToSecond(at: Date): string {
  return new Date(Math.floor(at.getTime() / 1000) * 1000).toISOString();
}

test('the expiry the caller is told is the expiry the token actually has', async () => {
  const harness = await start();

  const minted = (await mintFor(harness, harness.missionId)).json();
  const claims = decodeJwt(String(minted['token']));

  // The invariant, stated where it can be measured: the instant in the answer is the instant
  // the token stops working. Reported from the requested deadline instead, the two drifted by
  // up to 999 ms, and a client re-minting on the reported instant presented a dead token.
  expect(Number(claims.exp) * 1000).toBe(Date.parse(String(minted['expiresAt'])));
});

test('a token never outlives its mission, and never lives longer than an hour', async () => {
  const shortMission = await start({ expiresAt: new Date(Date.now() + 5 * 60 * 1000) });
  const shortToken = await mintFor(shortMission, shortMission.missionId);
  const shortMissionRow = await shortMission.prisma.mission.findUniqueOrThrow({
    where: { id: shortMission.missionId },
  });

  // The mission is the shorter of the two, so it is the deadline — to the second a token can
  // actually carry, which is the instant the answer reports.
  expect(String(shortToken.json()['expiresAt'])).toBe(flooredToSecond(shortMissionRow.expiresAt));

  const longMission = await start({ expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });
  const longToken = await mintFor(longMission, longMission.missionId);
  const ceiling = new Date(longMission.clock.now.getTime() + MAX_TOKEN_TTL_MS);

  // A mission that runs all day still hands out keys that are worth an hour.
  expect(String(longToken.json()['expiresAt'])).toBe(flooredToSecond(ceiling));
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

test('a gateway with no signing key says so, rather than failing as if it were broken', async () => {
  const harness = await start({ verifyOnly: true });

  const refused = await mintFor(harness, harness.missionId);

  expect(refused.statusCode).toBe(503);
  const body = refused.json();
  expect(body).toMatchObject({ error: 'agentgate_upstream_error' });
  // Machine-readable enough to act on: the reason names the setting that is missing.
  expect(String(body['reason'])).toContain('AGENTGATE_JWT_PRIVATE_KEY');
  // And no key material of any kind travels with it.
  expect(refused.body).not.toContain(process.env['AGENTGATE_JWT_PUBLIC_KEY'] ?? 'unset');

  // A verify-only gateway is a supported deployment, not a broken one: everything else answers.
  expect((await harness.admin('GET', '/api/v1/stats/overview')).statusCode).toBe(200);
  expect((await harness.admin('GET', `/api/v1/missions/${harness.missionId}`)).statusCode).toBe(
    200,
  );
  expect(
    (await harness.admin('POST', `/api/v1/missions/${harness.missionId}/expire`)).statusCode,
  ).toBe(200);
});

test('a verify-only gateway still enforces with a token minted elsewhere', async () => {
  const minting = await start();
  const token = String((await mintFor(minting, minting.missionId)).json()['token']);

  // Same database, same mission, a gateway that holds only the public key: the proxy path is
  // untouched by the absence of a signing key.
  const verifying = await start({ verifyOnly: true });
  const response = await verifying.app.inject({
    method: 'POST',
    url: '/v1/proxy',
    headers: { authorization: `Bearer ${token}` },
    payload: { credential: minting.alias, ...READ_REPO },
  });

  expect(response.statusCode).toBe(200);
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
