import { createTokenService } from '@agentgate/auth';
import { generateKeyPairSync } from 'node:crypto';
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

/** The one audit row this attempt was supposed to leave. */
async function auditRow(current: Harness) {
  const rows = await current.prisma.auditEvent.findMany({
    where: { missionId: current.missionId },
    orderBy: { timestamp: 'asc' },
  });

  return rows;
}

test('a token signed by another key is refused before anything is loaded', async () => {
  harness = await startHarness();
  const { privateKey } = generateKeyPairSync('ed25519');
  const foreign = createTokenService(
    privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    process.env['AGENTGATE_JWT_PUBLIC_KEY'] ?? '',
  );
  const token = await foreign.mint(
    {
      agentId: harness.agentId,
      principalId: harness.principalId,
      agentType: 'codex',
      missionId: harness.missionId,
      sessionId: 'ses_forged',
    },
    new Date(Date.now() + 60_000),
  );

  const response = await harness.proxy({ credential: harness.alias, ...READ_PAYMENTS }, token);

  expect(response.statusCode).toBe(401);
  expect(response.json()).toMatchObject({ error: 'agentgate_invalid_token' });
  expect(harness.upstreamRequests).toHaveLength(0);
});

test('an attempt with no identity still leaves exactly one audit row', async () => {
  harness = await startHarness();

  const response = await harness.proxy(
    { credential: harness.alias, ...READ_PAYMENTS },
    'not-even-a-jwt',
  );

  expect(response.statusCode).toBe(401);

  const rows = await harness.prisma.auditEvent.findMany({
    where: { requestId: String(response.json()['request_id']) },
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    decision: 'DENY',
    principalId: null,
    agentId: null,
    missionId: null,
    httpStatus: 401,
  });
});

test('a missing authorization header is refused like a bad token', async () => {
  harness = await startHarness();

  const response = await harness.proxy({ credential: harness.alias, ...READ_PAYMENTS }, undefined);

  expect(response.statusCode).toBe(401);
  expect(response.json()).toMatchObject({ error: 'agentgate_invalid_token' });
});

test('an expired token is refused', async () => {
  harness = await startHarness();
  const token = await harness.mint({}, new Date(Date.now() - 1_000));

  const response = await harness.proxy({ credential: harness.alias, ...READ_PAYMENTS }, token);

  expect(response.statusCode).toBe(401);
  expect(response.json()).toMatchObject({ error: 'agentgate_invalid_token' });
});

test('an expired mission is refused, and the row is marked expired on the way out', async () => {
  harness = await startHarness();
  const token = await harness.mint();
  // The token is still valid; the mission behind it is not.
  harness.clock.now = new Date(Date.now() + 2 * 60 * 60 * 1000);

  const response = await harness.proxy({ credential: harness.alias, ...READ_PAYMENTS }, token);

  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({
    error: 'agentgate_mission_expired',
    decision: 'DENY',
  });
  expect(harness.upstreamRequests).toHaveLength(0);

  const mission = await harness.prisma.mission.findUniqueOrThrow({
    where: { id: harness.missionId },
  });
  expect(mission.status).toBe('expired');
});

test('a revoked mission is refused', async () => {
  harness = await startHarness({ missionStatus: 'revoked' });
  const token = await harness.mint();

  const response = await harness.proxy({ credential: harness.alias, ...READ_PAYMENTS }, token);

  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({ error: 'agentgate_access_denied', decision: 'DENY' });
  expect((await auditRow(harness))[0]?.matchedPolicy).toBe('mission-revoked');
});

test('a token naming an identity the mission was not issued to is refused', async () => {
  harness = await startHarness();
  const token = await harness.mint({ agentId: 'agt_someone_else' });

  const response = await harness.proxy({ credential: harness.alias, ...READ_PAYMENTS }, token);

  expect(response.statusCode).toBe(403);
  expect((await auditRow(harness))[0]?.matchedPolicy).toBe('mission-identity-mismatch');
});

test('a repository outside the mission scope is denied without touching the upstream', async () => {
  harness = await startHarness({
    // The network rules allow the whole org, so only the mission scope can refuse it.
    network: {
      allow: [{ host: 'api.github.com', path: '/repos/acme/**', methods: ['GET'] }],
      deny: [],
    },
  });
  const token = await harness.mint();

  const response = await harness.proxy(
    {
      credential: harness.alias,
      method: 'GET',
      url: 'https://api.github.com/repos/acme/secret-project',
    },
    token,
  );

  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({ error: 'agentgate_access_denied', decision: 'DENY' });
  expect(harness.upstreamRequests).toHaveLength(0);

  const [row] = await auditRow(harness);
  expect(row).toMatchObject({
    decision: 'DENY',
    resource: 'github:acme/secret-project',
    action: 'repo.read',
    matchedPolicy: 'mission-resource-scope',
  });
});

test('a method the mission denies is refused even when the network allows it', async () => {
  harness = await startHarness({
    network: {
      allow: [
        { host: 'api.github.com', path: '/repos/acme/payments/**', methods: ['GET', 'DELETE'] },
      ],
      deny: [],
    },
  });
  const token = await harness.mint();

  const response = await harness.proxy(
    {
      credential: harness.alias,
      method: 'DELETE',
      url: 'https://api.github.com/repos/acme/payments',
    },
    token,
  );

  expect(response.statusCode).toBe(403);
  expect(harness.upstreamRequests).toHaveLength(0);
  expect((await auditRow(harness))[0]).toMatchObject({
    action: 'repository.delete',
    matchedPolicy: 'mission-denied-action',
  });
});

test('a method no network rule covers is refused by default deny', async () => {
  harness = await startHarness();
  const token = await harness.mint();

  const response = await harness.proxy(
    {
      credential: harness.alias,
      method: 'DELETE',
      url: 'https://api.github.com/repos/acme/payments',
    },
    token,
  );

  expect(response.statusCode).toBe(403);
  expect((await auditRow(harness))[0]?.matchedPolicy).toBe('network-default-deny');
});

test('a host no network rule covers is refused, credential or not', async () => {
  harness = await startHarness({
    network: { allow: [{ host: 'api.example.com' }], deny: [] },
  });
  const token = await harness.mint();

  const response = await harness.proxy({ credential: harness.alias, ...READ_PAYMENTS }, token);

  expect(response.statusCode).toBe(403);
  expect((await auditRow(harness))[0]?.matchedPolicy).toBe('network-default-deny');
});

test('an explicit deny rule wins over the allow rule next to it', async () => {
  harness = await startHarness({
    network: {
      allow: [{ host: 'api.github.com', path: '/repos/acme/payments/**', methods: ['GET'] }],
      deny: [{ host: 'api.github.com', path: '/repos/acme/payments/issues/**' }],
    },
  });
  const token = await harness.mint();

  const response = await harness.proxy(
    {
      credential: harness.alias,
      method: 'GET',
      url: 'https://api.github.com/repos/acme/payments/issues/423',
    },
    token,
  );

  expect(response.statusCode).toBe(403);

  const [row] = await auditRow(harness);
  expect(row?.matchedPolicy).toBe('network-deny-rule');
  // The trail names the rule that decided, not only the request that lost.
  expect(row?.reason).toContain('api.github.com/repos/acme/payments/issues/**');
  expect(response.json()['reason']).toContain('api.github.com/repos/acme/payments/issues/**');
});

test('a route no adapter maps is denied rather than guessed at', async () => {
  harness = await startHarness();
  const token = await harness.mint();

  const response = await harness.proxy(
    {
      credential: harness.alias,
      method: 'GET',
      url: 'https://api.github.com/repos/acme/payments/actions/runs',
    },
    token,
  );

  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({
    error: 'agentgate_unmapped_action',
    decision: 'DENY',
  });
  expect(harness.upstreamRequests).toHaveLength(0);
  expect((await auditRow(harness))[0]).toMatchObject({
    action: null,
    resource: null,
    matchedPolicy: 'adapter-unmapped',
  });
});

test('a HEAD request maps to no action, so it is denied', async () => {
  // Documented behaviour rather than an accident: the adapter table has no HEAD row, and an
  // unmapped method must never fall back to the GET rule that looks like it.
  harness = await startHarness({
    network: {
      allow: [
        { host: 'api.github.com', path: '/repos/acme/payments/**', methods: ['GET', 'HEAD'] },
      ],
      deny: [],
    },
  });
  const token = await harness.mint();

  const response = await harness.proxy(
    {
      credential: harness.alias,
      method: 'HEAD',
      url: 'https://api.github.com/repos/acme/payments',
    },
    token,
  );

  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({ error: 'agentgate_unmapped_action' });
});

test('unknown, revoked and out-of-scope aliases are indistinguishable to the agent', async () => {
  // Three different server-side facts, one answer. Telling them apart would confirm which
  // aliases exist and which are still active — an oracle an agent has no business holding.
  // The alias and the request id are the two things that legitimately differ between the runs:
  // the agent chose the first and the gateway minted the second. Everything else must match.
  async function refusal(current: Harness, alias: string): Promise<string> {
    const response = await current.proxy(
      { credential: alias, ...READ_PAYMENTS },
      await current.mint(),
    );

    expect(response.statusCode).toBe(403);

    return response.body
      .replaceAll(alias, 'ALIAS')
      .replace(/"request_id":"[^"]+"/, '"request_id":"REQ"');
  }

  const anyHost = { network: { allow: [{ host: '*' }], deny: [] } };
  const bodies: string[] = [];

  // An alias nobody ever created.
  harness = await startHarness(anyHost);
  bodies.push(await refusal(harness, 'no_such_alias'));
  await harness.close();

  // An alias that exists and has been revoked.
  harness = await startHarness({ ...anyHost, credentialStatus: 'revoked' });
  bodies.push(await refusal(harness, harness.alias));
  await harness.close();

  // An alias that exists, is active, and names a different host — left open for afterEach.
  harness = await startHarness({ ...anyHost, logicalHost: 'api.gitlab.com' });
  bodies.push(await refusal(harness, harness.alias));

  expect(new Set(bodies).size).toBe(1);
  expect(bodies[0]).toContain('agentgate_unknown_credential');
});

test('the trail still tells the three credential refusals apart, server-side', async () => {
  // A revoked credential being exercised is not the same event as an alias nobody ever had:
  // one is a typo, the other is something still holding a key that was taken away.
  harness = await startHarness({ credentialStatus: 'revoked' });
  const token = await harness.mint();

  await harness.proxy({ credential: harness.alias, ...READ_PAYMENTS }, token);
  await harness.proxy({ credential: 'no_such_alias', ...READ_PAYMENTS }, token);

  expect((await auditRow(harness)).map((row) => row.matchedPolicy)).toEqual([
    'credential-revoked',
    'credential-unknown',
  ]);
});

test('an unknown credential alias is refused', async () => {
  harness = await startHarness();
  const token = await harness.mint();

  const response = await harness.proxy({ credential: 'no_such_alias', ...READ_PAYMENTS }, token);

  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({
    error: 'agentgate_unknown_credential',
    decision: 'DENY',
  });
  expect(harness.upstreamRequests).toHaveLength(0);
});

test('a revoked credential is as good as an unknown one', async () => {
  harness = await startHarness({ credentialStatus: 'revoked' });
  const token = await harness.mint();

  const response = await harness.proxy({ credential: harness.alias, ...READ_PAYMENTS }, token);

  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({ error: 'agentgate_unknown_credential' });
});

test('a credential cannot be pointed at a host it does not name', async () => {
  harness = await startHarness({
    logicalHost: 'api.gitlab.com',
    network: { allow: [{ host: '*' }], deny: [] },
  });
  const token = await harness.mint();

  const response = await harness.proxy({ credential: harness.alias, ...READ_PAYMENTS }, token);

  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({ error: 'agentgate_unknown_credential' });
  expect((await auditRow(harness))[0]?.matchedPolicy).toBe('credential-host-scope');
});

test('an action gated behind an approval answers 202 and writes no approval record', async () => {
  harness = await startHarness();
  const token = await harness.mint();

  const response = await harness.proxy(
    {
      credential: harness.alias,
      method: 'POST',
      url: 'https://api.github.com/repos/acme/payments/pulls',
      headers: { 'Content-Type': 'application/json' },
      body: '{"title":"Fix duplicate charges"}',
    },
    token,
  );

  expect(response.statusCode).toBe(202);
  expect(response.json()).toMatchObject({
    error: 'agentgate_approval_required',
    decision: 'REQUIRE_APPROVAL',
  });
  expect(harness.upstreamRequests).toHaveLength(0);
  expect(await harness.prisma.approval.count({ where: { missionId: harness.missionId } })).toBe(0);

  const [row] = await auditRow(harness);
  expect(row).toMatchObject({
    decision: 'REQUIRE_APPROVAL',
    action: 'pull_request.create',
    matchedPolicy: 'mission-approval-required',
    bodySize: 33,
    contentType: 'application/json',
  });
  expect(row?.bodyHash).toMatch(/^[0-9a-f]{64}$/);
});

test.each([
  ['not a url at all', 'repos/acme/payments'],
  ['a scheme the gateway will not speak', 'file:///etc/passwd'],
  ['credentials smuggled into the authority', 'https://user:pw@api.github.com/repos/acme/payments'],
  ['a path that escapes the root', 'https://api.github.com/../../etc/passwd'],
  ['a backslash the upstream would read as a separator', 'https://api.github.com\\evil/repos/a/b'],
])('%s is refused as a validation error', async (_name, url) => {
  harness = await startHarness();
  const token = await harness.mint();

  const response = await harness.proxy({ credential: harness.alias, method: 'GET', url }, token);

  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ error: 'agentgate_validation_error' });
  expect(harness.upstreamRequests).toHaveLength(0);
  expect((await auditRow(harness))[0]?.matchedPolicy).toBe('request-invalid-url');
});

test.each([
  [
    'a field the contract does not name',
    { credential: 'a', method: 'GET', url: 'https://a/b', upstream: 'x' },
  ],
  ['a missing credential', { method: 'GET', url: 'https://api.github.com/repos/acme/payments' }],
  ['a method that is not one', { credential: 'a', method: 'TRACE', url: 'https://a/b' }],
  [
    'a body that is not a string',
    { credential: 'a', method: 'POST', url: 'https://a/b', body: { a: 1 } },
  ],
])('%s is refused, and still leaves an audit row', async (_name, body) => {
  harness = await startHarness();
  const token = await harness.mint();

  const response = await harness.proxy(body, token);

  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ error: 'agentgate_validation_error' });

  const rows = await harness.prisma.auditEvent.findMany({
    where: { requestId: String(response.json()['request_id']) },
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]?.agentId).toBe(harness.agentId);
  // Every refusal names the stage that made it, validation included.
  expect(rows[0]?.matchedPolicy).toBe('request-invalid-envelope');
});

test.each([
  [
    'an alias longer than any alias',
    { credential: 'a'.repeat(200), url: 'https://api.github.com/x' },
  ],
  [
    'a url longer than any url',
    { credential: 'github_work', url: `https://api.github.com/${'a'.repeat(5_000)}` },
  ],
])('%s is refused before it can be written down', async (_name, fields) => {
  // The trail is append-only: whatever an agent puts in these two fields is quoted back in
  // `reason` and kept forever. Unbounded, a denied request is a free megabyte of indelible
  // storage per attempt, which is a cheaper attack than any of the ones policy is guarding.
  harness = await startHarness();
  const token = await harness.mint();

  const response = await harness.proxy({ method: 'GET', ...fields }, token);

  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ error: 'agentgate_validation_error' });

  const rows = await auditRow(harness);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.matchedPolicy).toBe('request-invalid-envelope');
  expect(rows[0]?.reason.length).toBeLessThan(500);
});

test('an alias at the cap is still accepted, so the bound is a limit and not a trap', async () => {
  harness = await startHarness();
  const token = await harness.mint();

  const response = await harness.proxy(
    { credential: 'a'.repeat(128), method: 'GET', url: 'https://api.github.com/repos/acme/x' },
    token,
  );

  // Refused for not existing, which means the envelope itself was read and understood.
  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({ error: 'agentgate_unknown_credential' });
});

test('no refusal ever leaves the trail without saying which stage made it', async () => {
  harness = await startHarness();
  const token = await harness.mint();

  await harness.proxy({ nonsense: true }, token);
  await harness.proxy({ credential: harness.alias, method: 'GET', url: 'nope' }, token);
  await harness.proxy({ credential: 'no_such_alias', ...READ_PAYMENTS }, token);
  await harness.proxy(
    { credential: harness.alias, method: 'DELETE', url: 'https://api.github.com/repos/acme/x' },
    token,
  );

  const rows = await auditRow(harness);

  expect(rows).toHaveLength(4);
  expect(rows.map((row) => row.matchedPolicy)).toEqual([
    'request-invalid-envelope',
    'request-invalid-url',
    'credential-unknown',
    'network-default-deny',
  ]);
});

test('a body that is not json at all is refused by the pipeline, not by the framework', async () => {
  harness = await startHarness();
  const token = await harness.mint();

  const response = await harness.app.inject({
    method: 'POST',
    url: '/v1/proxy',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: '{ this is not json',
  });

  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ error: 'agentgate_validation_error' });

  const rows = await harness.prisma.auditEvent.findMany({
    where: { requestId: String(response.json()['request_id']) },
  });
  expect(rows).toHaveLength(1);
});

test('an unreachable upstream is a 502 recorded as an error, not as a decision', async () => {
  harness = await startHarness({ upstreamBaseUrl: 'http://127.0.0.1:1' });
  const token = await harness.mint();

  const response = await harness.proxy({ credential: harness.alias, ...READ_PAYMENTS }, token);

  expect(response.statusCode).toBe(502);
  expect(response.json()).toMatchObject({ error: 'agentgate_upstream_error' });

  const [row] = await auditRow(harness);
  expect(row).toMatchObject({ decision: 'ERROR', httpStatus: 502 });
});
