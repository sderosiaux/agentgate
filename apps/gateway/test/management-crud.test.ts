import { afterEach, expect, test } from 'vitest';
import {
  DEFAULT_LIMITS,
  DEFAULT_NETWORK,
  DEFAULT_PERMISSIONS,
  startHarness,
  type Harness,
} from './helpers/gateway.js';

const started: Harness[] = [];
/** Rows the management API created, which no harness `close()` knows about. */
const createdMissions: string[] = [];
const createdAgents: string[] = [];
const createdPrincipals: string[] = [];

afterEach(async () => {
  for (const harness of started) {
    await harness.prisma.mission.deleteMany({ where: { id: { in: createdMissions } } });
    await harness.prisma.agent.deleteMany({ where: { id: { in: createdAgents } } });
    await harness.prisma.principal.deleteMany({ where: { id: { in: createdPrincipals } } });
  }
  createdMissions.length = 0;
  createdAgents.length = 0;
  createdPrincipals.length = 0;

  await Promise.all(started.splice(0).map(async (harness) => harness.close()));
});

async function start(): Promise<Harness> {
  const harness = await startHarness();
  started.push(harness);

  return harness;
}

function inAnHour(): string {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

/** The whole chain a demo needs: a principal, an agent under it, a mission for that agent. */
async function createChain(harness: Harness): Promise<{
  principalId: string;
  agentId: string;
  missionId: string;
}> {
  const principal = await harness.admin('POST', '/api/v1/principals', {
    body: { name: 'Payments team' },
  });
  expect(principal.statusCode).toBe(201);
  const principalId = String(principal.json()['id']);
  createdPrincipals.push(principalId);

  const agent = await harness.admin('POST', '/api/v1/agents', {
    body: { principalId, agentType: 'codex' },
  });
  expect(agent.statusCode).toBe(201);
  const agentId = String(agent.json()['id']);
  createdAgents.push(agentId);

  const mission = await harness.admin('POST', '/api/v1/missions', {
    body: {
      principalId,
      agentId,
      intent: 'Investigate issue #423',
      permissions: DEFAULT_PERMISSIONS,
      network: DEFAULT_NETWORK,
      limits: DEFAULT_LIMITS,
      expiresAt: inAnHour(),
    },
  });
  expect(mission.statusCode).toBe(201);
  const missionId = String(mission.json()['id']);
  createdMissions.push(missionId);

  return { principalId, agentId, missionId };
}

test('a principal, an agent and a mission can be created and read back', async () => {
  const harness = await start();
  const { principalId, agentId, missionId } = await createChain(harness);

  expect(principalId).toMatch(/^pri_/);
  expect(agentId).toMatch(/^agt_/);
  expect(missionId).toMatch(/^mis_/);

  const principals = (await harness.admin('GET', '/api/v1/principals')).json()['principals'] as {
    id: string;
    name: string;
  }[];
  expect(principals).toContainEqual({ id: principalId, name: 'Payments team' });

  const agents = (await harness.admin('GET', `/api/v1/agents?principalId=${principalId}`)).json()[
    'agents'
  ] as { id: string }[];
  expect(agents.map((agent) => agent.id)).toEqual([agentId]);

  const mission = await harness.admin('GET', `/api/v1/missions/${missionId}`);
  expect(mission.statusCode).toBe(200);
  expect(mission.json()).toMatchObject({
    id: missionId,
    principalId,
    agentId,
    status: 'active',
    environment: 'development',
    permissions: DEFAULT_PERMISSIONS,
    network: DEFAULT_NETWORK,
    limits: DEFAULT_LIMITS,
    // No request has been made on it, and zero is the honest reading of that.
    usage: { requestCount: 0, bytesTotal: 0 },
  });

  const missions = (
    await harness.admin('GET', `/api/v1/missions?agentId=${agentId}&status=active`)
  ).json()['missions'] as { id: string }[];
  expect(missions.map((row) => row.id)).toEqual([missionId]);
});

test('the agent detail carries its live mission and what the trail says about it', async () => {
  const harness = await start();

  // The harness agent already has a mission and, after one proxied request, a trail.
  const token = await harness.mint();
  const proxied = await harness.proxy(
    { credential: harness.alias, method: 'GET', url: 'https://api.github.com/repos/acme/payments' },
    token,
  );
  expect(proxied.statusCode).toBe(200);

  const detail = await harness.admin('GET', `/api/v1/agents/${harness.agentId}`);
  expect(detail.statusCode).toBe(200);

  const body = detail.json();
  expect(body).toMatchObject({
    id: harness.agentId,
    principalId: harness.principalId,
    agentType: 'codex',
    activeMission: { id: harness.missionId, status: 'active' },
  });

  const recent = body['recentAudit'] as {
    total: number;
    byDecision: Record<string, number>;
    events: { requestId: string; decision: string }[];
  };
  expect(recent.total).toBe(1);
  expect(recent.byDecision).toEqual({ ALLOW: 1, DENY: 0, REQUIRE_APPROVAL: 0, ERROR: 0 });
  expect(recent.events[0]).toMatchObject({ decision: 'ALLOW', action: 'repo.read' });
});

test('an expired mission is not the agent detail page`s active mission', async () => {
  const harness = await start();

  await harness.admin('POST', `/api/v1/missions/${harness.missionId}/expire`);

  const detail = await harness.admin('GET', `/api/v1/agents/${harness.agentId}`);
  expect(detail.json()['activeMission']).toBeNull();
});

test('mission create refuses scope the policy engine could not read', async () => {
  const harness = await start();
  const { principalId, agentId } = await createChain(harness);

  const base = {
    principalId,
    agentId,
    intent: 'Something',
    permissions: DEFAULT_PERMISSIONS,
    network: DEFAULT_NETWORK,
    limits: DEFAULT_LIMITS,
    expiresAt: inAnHour(),
  };

  const refusals: [string, unknown][] = [
    // A permissions document with a field the schema does not name: silently ignoring it is how
    // a mission ends up granting something its author did not write.
    [
      'unknown permission field',
      { ...base, permissions: { ...DEFAULT_PERMISSIONS, allow: ['*'] } },
    ],
    ['permissions of the wrong shape', { ...base, permissions: { resources: 'github:acme/*' } }],
    [
      'a method no rule can express',
      { ...base, network: { allow: [{ host: 'x', methods: ['FETCH'] }], deny: [] } },
    ],
    ['a negative budget', { ...base, limits: { ...DEFAULT_LIMITS, maxRequests: -1 } }],
    ['a deadline already past', { ...base, expiresAt: new Date(Date.now() - 1000).toISOString() }],
    ['a deadline that is not a date', { ...base, expiresAt: 'tomorrow' }],
    ['an agent nobody registered', { ...base, agentId: 'agt_nobody' }],
    ['an intent nobody wrote', { ...base, intent: '' }],
  ];

  for (const [what, body] of refusals) {
    const response = await harness.admin('POST', '/api/v1/missions', { body });

    expect({ what, status: response.statusCode }).toEqual({ what, status: 400 });
    expect(response.json()).toMatchObject({ error: 'agentgate_validation_error' });
  }
});

test('a mission cannot name an agent that belongs to somebody else', async () => {
  const harness = await start();
  const { agentId } = await createChain(harness);
  const other = await harness.admin('POST', '/api/v1/principals', { body: { name: 'Other team' } });
  const otherPrincipalId = String(other.json()['id']);
  createdPrincipals.push(otherPrincipalId);

  const response = await harness.admin('POST', '/api/v1/missions', {
    body: {
      principalId: otherPrincipalId,
      agentId,
      intent: 'Borrow an agent',
      permissions: DEFAULT_PERMISSIONS,
      network: DEFAULT_NETWORK,
      limits: DEFAULT_LIMITS,
      expiresAt: inAnHour(),
    },
  });

  // The pair would fail the token identity check on every proxied request (D9). Refusing to
  // create it is the difference between a 400 now and a mission that never works.
  expect(response.statusCode).toBe(400);
  expect(String(response.json()['reason'])).toContain('does not belong');
});

test('an agent cannot be registered under a principal that does not exist, or as a type nobody enforces', async () => {
  const harness = await start();

  const orphan = await harness.admin('POST', '/api/v1/agents', {
    body: { principalId: 'pri_nobody', agentType: 'codex' },
  });
  expect(orphan.statusCode).toBe(400);

  const unknownType = await harness.admin('POST', '/api/v1/agents', {
    body: { principalId: harness.principalId, agentType: 'Codex' },
  });
  expect(unknownType.statusCode).toBe(400);
});

test('reads of things that do not exist say so', async () => {
  const harness = await start();

  for (const url of [
    '/api/v1/agents/agt_nobody',
    '/api/v1/missions/mis_nobody',
    '/api/v1/decisions/req_nobody',
  ]) {
    const response = await harness.admin('GET', url);

    expect({ url, status: response.statusCode }).toEqual({ url, status: 404 });
    expect(response.json()).toMatchObject({ error: 'agentgate_not_found' });
  }
});
