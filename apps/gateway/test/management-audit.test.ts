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

const READ_REPO = {
  method: 'GET',
  url: 'https://api.github.com/repos/acme/payments',
} as const;

const OPEN_PULL_REQUEST = {
  method: 'POST',
  url: 'https://api.github.com/repos/acme/payments/pulls',
  headers: { 'Content-Type': 'application/json' },
  body: '{"title":"Fix duplicate charges"}',
} as const;

/**
 * Rows written straight to the table rather than through the pipeline.
 *
 * The trail is append-only, so a test cannot clean up after itself and cannot rely on being
 * alone in the table either: every row here is tagged with a mission id nobody else will ever
 * use, and every assertion filters by it.
 */
async function seedTrail(
  harness: Harness,
  missionId: string,
  rows: {
    minutesAgo: number;
    decision: string;
    resource?: string;
    agentId?: string;
    principalId?: string;
  }[],
): Promise<string[]> {
  const ids: string[] = [];

  for (const [index, row] of rows.entries()) {
    const id = `aud_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    ids.push(id);

    await harness.prisma.auditEvent.create({
      data: {
        id,
        requestId: `req_seed_${String(index)}_${missionId.slice(-8)}`,
        timestamp: new Date(Date.now() - row.minutesAgo * 60_000),
        missionId,
        agentId: row.agentId ?? `agt_seed_${missionId.slice(-8)}`,
        principalId: row.principalId ?? `pri_seed_${missionId.slice(-8)}`,
        resource: row.resource ?? 'github:acme/payments',
        action: 'repo.read',
        method: 'GET',
        decision: row.decision,
        reason: `seeded ${row.decision}`,
        latencyMs: 1,
      },
    });
  }

  return ids;
}

function seedMissionId(): string {
  return `mis_audit_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

async function listAudit(
  harness: Harness,
  query: string,
): Promise<{
  events: { id: string; decision: string; resource: string | null }[];
  nextCursor: string | null;
}> {
  const response = await harness.admin('GET', `/api/v1/audit?${query}`);
  expect(response.statusCode).toBe(200);

  return response.json() as never;
}

test('the trail can be read back filtered by every dimension it records', async () => {
  const harness = await start();
  const missionId = seedMissionId();
  const agentId = `agt_seed_${missionId.slice(-8)}`;
  const principalId = `pri_seed_${missionId.slice(-8)}`;

  await seedTrail(harness, missionId, [
    { minutesAgo: 1, decision: 'ALLOW' },
    { minutesAgo: 2, decision: 'DENY' },
    { minutesAgo: 3, decision: 'DENY', resource: 'github:acme/billing' },
    { minutesAgo: 120, decision: 'ALLOW' },
  ]);

  const all = await listAudit(harness, `missionId=${missionId}`);
  expect(all.events).toHaveLength(4);
  // Newest first, which is the order every reader of a trail expects.
  expect(all.events.map((event) => event.decision)).toEqual(['ALLOW', 'DENY', 'DENY', 'ALLOW']);

  const denied = await listAudit(harness, `missionId=${missionId}&decision=DENY`);
  expect(denied.events).toHaveLength(2);

  const byResource = await listAudit(
    harness,
    `missionId=${missionId}&resource=github:acme/billing`,
  );
  expect(byResource.events.map((event) => event.resource)).toEqual(['github:acme/billing']);

  expect((await listAudit(harness, `agentId=${agentId}`)).events).toHaveLength(4);
  expect((await listAudit(harness, `principalId=${principalId}`)).events).toHaveLength(4);

  // A window that ends before the oldest row and one that starts after it.
  const lastHour = new Date(Date.now() - 60 * 60_000).toISOString();
  const recent = await listAudit(harness, `missionId=${missionId}&from=${lastHour}`);
  expect(recent.events).toHaveLength(3);

  const old = await listAudit(harness, `missionId=${missionId}&to=${lastHour}`);
  expect(old.events).toHaveLength(1);

  // Two filters that cannot both be true of any row.
  const none = await listAudit(harness, `missionId=${missionId}&agentId=agt_somebody_else`);
  expect(none.events).toEqual([]);
});

test('paging through the trail is stable while it is being written to', async () => {
  const harness = await start();
  const missionId = seedMissionId();

  const seeded = await seedTrail(
    harness,
    missionId,
    [10, 20, 30, 40, 50].map((minutesAgo) => ({ minutesAgo, decision: 'ALLOW' })),
  );
  const newestFirst = seeded; // seeded oldest-last: 10 minutes ago is the newest

  const first = await listAudit(harness, `missionId=${missionId}&limit=2`);
  expect(first.events.map((event) => event.id)).toEqual(newestFirst.slice(0, 2));
  expect(first.nextCursor).toBe(newestFirst[1]);

  // The trail grows between the two pages, which is what it does all day.
  await seedTrail(harness, missionId, [
    { minutesAgo: 0, decision: 'DENY' },
    { minutesAgo: 1, decision: 'DENY' },
  ]);

  const second = await listAudit(
    harness,
    `missionId=${missionId}&limit=2&cursor=${String(first.nextCursor)}`,
  );

  // Neither shifted by the insertion nor repeated from the first page: a cursor names a row,
  // not an offset.
  expect(second.events.map((event) => event.id)).toEqual(newestFirst.slice(2, 4));

  const third = await listAudit(
    harness,
    `missionId=${missionId}&limit=2&cursor=${String(second.nextCursor)}`,
  );
  expect(third.events.map((event) => event.id)).toEqual(newestFirst.slice(4));
  expect(third.nextCursor).toBeNull();
});

test('a cursor naming no row is refused rather than answered with the first page again', async () => {
  const harness = await start();

  const response = await harness.admin('GET', '/api/v1/audit?cursor=aud_nobody');
  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ error: 'agentgate_validation_error' });

  // And a limit nobody should be able to ask for.
  expect((await harness.admin('GET', '/api/v1/audit?limit=100000')).statusCode).toBe(400);
  expect((await harness.admin('GET', '/api/v1/audit?limit=0')).statusCode).toBe(400);
  expect((await harness.admin('GET', '/api/v1/audit?decision=MAYBE')).statusCode).toBe(400);
  expect((await harness.admin('GET', '/api/v1/audit?from=yesterday')).statusCode).toBe(400);
  expect((await harness.admin('GET', '/api/v1/audit?nosuchfilter=1')).statusCode).toBe(400);
});

test('the approval queue pages the same way', async () => {
  const harness = await start();
  const token = await harness.mint();
  await harness.proxy({ credential: harness.alias, ...OPEN_PULL_REQUEST }, token);

  const page = await harness.admin(
    'GET',
    `/api/v1/approvals?missionId=${harness.missionId}&limit=1`,
  );
  expect(page.statusCode).toBe(200);
  expect(page.json()['approvals']).toHaveLength(1);
  expect(page.json()).toHaveProperty('nextCursor', null);

  expect((await harness.admin('GET', '/api/v1/approvals?cursor=apr_nobody')).statusCode).toBe(400);
});

test('a decision can be read back with the question the engine was asked', async () => {
  const harness = await start();
  const token = await harness.mint();

  const allowed = await harness.proxy({ credential: harness.alias, ...READ_REPO }, token);
  expect(allowed.statusCode).toBe(200);
  const requestId = String(allowed.headers['x-agentgate-request-id']);

  const decision = await harness.admin('GET', `/api/v1/decisions/${requestId}`);
  expect(decision.statusCode).toBe(200);

  const body = decision.json();
  expect(body).toMatchObject({
    requestId,
    decision: 'ALLOW',
    missionId: harness.missionId,
    agentId: harness.agentId,
    principalId: harness.principalId,
    resource: 'github:acme/payments',
    action: 'repo.read',
    method: 'GET',
    destHost: 'api.github.com',
    httpStatus: 200,
  });

  // The snapshot is the PolicyInput as the engine saw it: identity, the mission scope in force
  // at the time, what the request was mapped to, and metadata about the body — never the body.
  expect(body['policyInputSnapshot']).toMatchObject({
    identity: {
      principalId: harness.principalId,
      agentId: harness.agentId,
      agentType: 'codex',
    },
    mission: { id: harness.missionId, permissions: { allowedActions: expect.any(Array) } },
    resource: { provider: 'github', id: 'acme/payments' },
    action: { type: 'repo.read', method: 'GET' },
    network: { host: 'api.github.com', path: '/repos/acme/payments' },
    environment: { name: 'development' },
    currentState: { requestCount: expect.any(Number), bytesTotal: expect.any(Number) },
    data: { bodySize: 0 },
  });
});

/** Every key in a nested document, so an assertion can be made about all of them at once. */
function everyKey(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      everyKey(item, keys);
    }

    return keys;
  }

  if (value === null || typeof value !== 'object') {
    return keys;
  }

  for (const [key, child] of Object.entries(value)) {
    keys.push(key);
    everyKey(child, keys);
  }

  return keys;
}

test('the snapshot carries no header, no body and no credential, at any depth', async () => {
  const harness = await start();
  const token = await harness.mint();

  const allowed = await harness.proxy(
    {
      credential: harness.alias,
      method: 'GET',
      url: 'https://api.github.com/repos/acme/payments',
      // Headers the agent chose, including one that carries its own credential material.
      headers: {
        authorization: 'Bearer agent-supplied-secret',
        'content-type': 'application/json',
      },
    },
    token,
  );
  expect(allowed.statusCode).toBe(200);

  const decision = (
    await harness.admin(
      'GET',
      `/api/v1/decisions/${String(allowed.headers['x-agentgate-request-id'])}`,
    )
  ).json();

  const keys = everyKey(decision['policyInputSnapshot']).map((key) => key.toLowerCase());
  for (const forbidden of [
    'authorization',
    'headers',
    'body',
    'token',
    'secret',
    'credential',
    'value',
  ]) {
    expect(keys).not.toContain(forbidden);
  }

  expect(JSON.stringify(decision)).not.toContain('agent-supplied-secret');
});

test('an attempt refused before the engine leaves no snapshot to read', async () => {
  const harness = await start();

  // No token at all: the pipeline never gets as far as building a policy input, and inventing
  // one would be a lie about what was evaluated.
  const refused = await harness.proxy({ credential: harness.alias, ...READ_REPO }, undefined);
  expect(refused.statusCode).toBe(401);

  const decision = await harness.admin(
    'GET',
    `/api/v1/decisions/${String(refused.headers['x-agentgate-request-id'])}`,
  );

  expect(decision.statusCode).toBe(200);
  expect(decision.json()).toMatchObject({ decision: 'DENY' });
  expect(decision.json()['policyInputSnapshot']).toBeNull();

  // Same for a refusal that gets further but still stops short of the engine.
  const unknownCredential = await harness.proxy(
    { credential: 'nobody_ever_created_this', ...READ_REPO },
    await harness.mint(),
  );
  const later = await harness.admin(
    'GET',
    `/api/v1/decisions/${String(unknownCredential.headers['x-agentgate-request-id'])}`,
  );
  expect(later.json()['policyInputSnapshot']).toBeNull();
});
