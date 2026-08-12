import { afterEach, expect, test } from 'vitest';
import type { Prisma } from '../src/generated/prisma/client.js';
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
 * The alias an operator would keep for the credential nobody's agent is supposed to hold. It is
 * created next to the mission's own, on the same logical host and the same provider, because
 * that is the case the mission document has to decide: everything else about the request is
 * legitimate, and only the choice of key is not.
 */
async function registerNeighbourCredential(current: Harness, alias: string): Promise<void> {
  const own = await current.prisma.credential.findUniqueOrThrow({
    where: { alias: current.alias },
  });

  await current.prisma.credential.create({
    data: {
      id: `cred_neighbour_${alias}`,
      alias,
      provider: own.provider,
      logicalHost: own.logicalHost,
      upstreamBaseUrl: own.upstreamBaseUrl,
      injection: own.injection as Prisma.InputJsonValue,
      ciphertext: own.ciphertext,
      status: own.status,
    },
  });
}

test('an agent cannot spend a credential its mission does not list', async () => {
  harness = await startHarness();
  const alias = `prod_admin_${harness.missionId}`;
  await registerNeighbourCredential(harness, alias);
  const token = await harness.mint();

  const response = await harness.proxy({ credential: alias, ...READ_PAYMENTS }, token);

  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({
    error: 'agentgate_unknown_credential',
    decision: 'DENY',
  });
  expect(harness.upstreamRequests).toHaveLength(0);

  await harness.prisma.credential.deleteMany({ where: { alias } });
});

test('the refusal says nothing about whether the alias exists', async () => {
  // The point of binding credentials to a mission is lost if the refusal is a lookup service:
  // an agent that can tell "not yours" from "no such thing" can enumerate the whole store one
  // guess at a time. Both answers are the same bytes.
  harness = await startHarness();
  const alias = `prod_admin_${harness.missionId}`;
  await registerNeighbourCredential(harness, alias);
  const token = await harness.mint();

  /** The two things a refusal is allowed to differ in: the id of the attempt, and the alias. */
  const shape = (response: { body: string }): unknown => ({
    ...(JSON.parse(response.body) as Record<string, unknown>),
    request_id: '<request id>',
    reason: '<reason naming the alias>',
  });

  const real = await harness.proxy({ credential: alias, ...READ_PAYMENTS }, token);
  const invented = await harness.proxy(
    { credential: 'nothing_by_this_name', ...READ_PAYMENTS },
    token,
  );

  expect(shape(real)).toEqual(shape(invented));
  expect(JSON.parse(real.body)['reason']).toBe(`credential ${alias} is unknown`);
  expect(JSON.parse(invented.body)['reason']).toBe('credential nothing_by_this_name is unknown');
  expect(new Set([real.statusCode, invented.statusCode]).size).toBe(1);

  await harness.prisma.credential.deleteMany({ where: { alias } });
});

test('the trail says the mission refused it, not that the alias is unknown', async () => {
  harness = await startHarness();
  const alias = `prod_admin_${harness.missionId}`;
  await registerNeighbourCredential(harness, alias);
  const token = await harness.mint();

  await harness.proxy({ credential: alias, ...READ_PAYMENTS }, token);

  const rows = await harness.prisma.auditEvent.findMany({
    where: { missionId: harness.missionId },
  });
  expect(rows.map((row) => row.matchedPolicy)).toEqual(['credential-not-in-mission']);

  await harness.prisma.credential.deleteMany({ where: { alias } });
});

test('the mission is asked before the credential row is even read', async () => {
  // An alias that names nothing and an alias that names something both stop here, which is what
  // makes the refusal above indistinguishable: the store is not consulted either way.
  harness = await startHarness({ allowedCredentials: [] });
  const token = await harness.mint();

  const response = await harness.proxy({ credential: harness.alias, ...READ_PAYMENTS }, token);

  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({ error: 'agentgate_unknown_credential' });

  const rows = await harness.prisma.auditEvent.findMany({
    where: { missionId: harness.missionId },
  });
  expect(rows[0]?.matchedPolicy).toBe('credential-not-in-mission');
});

test('a mission whose permissions predate the field grants no credential at all', async () => {
  // What a live database holds: a permissions document written before `allowedCredentials`
  // existed. Absent must not read as "all of them" — that is the hole this closes.
  harness = await startHarness();
  const { allowedCredentials, ...legacy } = (
    await harness.prisma.mission.findUniqueOrThrow({ where: { id: harness.missionId } })
  ).permissions as Record<string, unknown>;
  expect(allowedCredentials).toBeDefined();

  await harness.prisma.mission.update({
    where: { id: harness.missionId },
    data: { permissions: legacy as Prisma.InputJsonValue },
  });
  const token = await harness.mint();

  const response = await harness.proxy({ credential: harness.alias, ...READ_PAYMENTS }, token);

  expect(response.statusCode).toBe(403);
  expect(harness.upstreamRequests).toHaveLength(0);
});

test('the alias the mission does list still works', async () => {
  harness = await startHarness();
  const token = await harness.mint();

  const response = await harness.proxy({ credential: harness.alias, ...READ_PAYMENTS }, token);

  expect(response.statusCode).toBe(200);
  expect(harness.upstreamRequests).toHaveLength(1);
});

test('the policy engine is told which credential the request named', async () => {
  harness = await startHarness();
  const token = await harness.mint();

  const response = await harness.proxy({ credential: harness.alias, ...READ_PAYMENTS }, token);

  const row = await harness.prisma.auditEvent.findFirstOrThrow({
    where: { requestId: String(response.headers['x-agentgate-request-id']) },
  });
  expect(row.policyInputSnapshot).toMatchObject({ credentialAlias: harness.alias });
});
