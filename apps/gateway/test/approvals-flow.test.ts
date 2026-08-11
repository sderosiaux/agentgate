import type { MissionPermissions, NetworkRules } from '@agentgate/shared';
import { afterEach, expect, test } from 'vitest';
import { APPROVAL_GRANT_TTL_MS } from '../src/approvals/service.js';
import {
  ADMIN_TOKEN,
  DEFAULT_PERMISSIONS,
  startHarness,
  type Harness,
  type HarnessOptions,
} from './helpers/gateway.js';

const started: Harness[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map(async (harness) => harness.close()));
});

async function start(options: HarnessOptions = {}): Promise<Harness> {
  const harness = await startHarness(options);
  started.push(harness);

  return harness;
}

/** The gated request the whole of D7 is written around: opening a pull request. */
const OPEN_PULL_REQUEST = {
  method: 'POST',
  url: 'https://api.github.com/repos/acme/payments/pulls',
  headers: { 'Content-Type': 'application/json' },
  body: '{"title":"Fix duplicate charges"}',
} as const;

async function openPullRequest(harness: Harness, token: string, approvalId?: string) {
  return harness.proxy(
    {
      credential: harness.alias,
      ...OPEN_PULL_REQUEST,
      ...(approvalId === undefined ? {} : { approvalId }),
    },
    token,
  );
}

/** The audit row an attempt left, found by the request id the agent was handed. */
async function auditRowFor(harness: Harness, requestId: string) {
  return harness.prisma.auditEvent.findFirstOrThrow({ where: { requestId } });
}

function requestIdOf(response: Awaited<ReturnType<Harness['proxy']>>): string {
  return String(response.headers['x-agentgate-request-id']);
}

test('a gated action answers 202 with the approval a human now has to decide', async () => {
  const harness = await start();
  const token = await harness.mint();

  const response = await openPullRequest(harness, token);

  expect(response.statusCode).toBe(202);
  const body = response.json();
  expect(body).toMatchObject({
    error: 'agentgate_approval_required',
    decision: 'REQUIRE_APPROVAL',
    reason: expect.stringContaining('approval'),
  });
  expect(String(body['approval_id'])).toMatch(/^apr_/);
  expect(harness.upstreamRequests).toHaveLength(0);

  const approval = await harness.prisma.approval.findUniqueOrThrow({
    where: { id: String(body['approval_id']) },
  });
  expect(approval).toMatchObject({
    missionId: harness.missionId,
    agentId: harness.agentId,
    resource: 'github:acme/payments',
    action: 'pull_request.create',
    status: 'pending',
    decidedAt: null,
    grantExpiresAt: null,
  });
  // What a human needs to decide, and nothing from the body itself (D10).
  expect(approval.requestSummary).toEqual({
    method: 'POST',
    host: 'api.github.com',
    path: '/repos/acme/payments/pulls',
    bodySize: 33,
    contentType: 'application/json',
  });

  const row = await auditRowFor(harness, requestIdOf(response));
  expect(row).toMatchObject({
    decision: 'REQUIRE_APPROVAL',
    action: 'pull_request.create',
    matchedPolicy: 'mission-approval-required',
    approvalId: approval.id,
    bodySize: 33,
    contentType: 'application/json',
  });
  expect(row.bodyHash).toMatch(/^[0-9a-f]{64}$/);
});

test('an agent that keeps retrying asks the same question, not a new one each time', async () => {
  const harness = await start();
  const token = await harness.mint();

  const first = await openPullRequest(harness, token);
  const second = await openPullRequest(harness, token);

  expect(second.statusCode).toBe(202);
  expect(second.json()['approval_id']).toBe(first.json()['approval_id']);
  expect(await harness.prisma.approval.count({ where: { missionId: harness.missionId } })).toBe(1);
});

test('a burst of first attempts asks a human exactly once', async () => {
  const harness = await start();
  const token = await harness.mint();

  // The retry loop an agent actually writes: not two requests one after the other, but a
  // handful in flight at once. Read-then-create lets every one of them find nothing and
  // create its own row — measured at 13 to 23 rows out of 24 attempts before the unique
  // index below existed, which is a human queue filled by a single intent.
  const responses = await Promise.all(
    Array.from({ length: 24 }, async () => openPullRequest(harness, token)),
  );

  expect(responses.map((response) => response.statusCode)).toEqual(Array<number>(24).fill(202));
  expect(new Set(responses.map((response) => String(response.json()['approval_id'])))).toHaveLength(
    1,
  );
  expect(await harness.prisma.approval.count({ where: { missionId: harness.missionId } })).toBe(1);
});

test('approved, retried, and the request goes through exactly as an ALLOW would', async () => {
  const harness = await start();
  const token = await harness.mint();
  const approvalId = String((await openPullRequest(harness, token)).json()['approval_id']);

  const decision = await harness.admin('POST', `/api/v1/approvals/${approvalId}/approve`, {
    body: { decidedBy: 'alice@acme.example' },
  });
  expect(decision.statusCode).toBe(200);
  expect(decision.json()).toMatchObject({ status: 'approved', decidedBy: 'alice@acme.example' });

  // What the agent sees while it waits: enough to know it may retry, and nothing else.
  const status = await harness.approvalStatus(approvalId, token);
  expect(status.statusCode).toBe(200);
  expect(status.json()).toEqual({
    id: approvalId,
    status: 'approved',
    resource: 'github:acme/payments',
    action: 'pull_request.create',
    requestedAt: expect.any(String),
    decidedAt: expect.any(String),
  });

  const retry = await openPullRequest(harness, token, approvalId);

  expect(retry.statusCode).toBe(201);
  expect(harness.upstreamRequests).toHaveLength(1);
  expect(harness.upstreamRequests[0]).toMatchObject({
    method: 'POST',
    url: '/repos/acme/payments/pulls',
  });

  const row = await auditRowFor(harness, requestIdOf(retry));
  expect(row).toMatchObject({
    decision: 'ALLOW',
    action: 'pull_request.create',
    matchedPolicy: 'approval-grant',
    approvalId,
    httpStatus: 201,
  });
});

test('a grant is spent by the request that used it: the second retry is refused', async () => {
  const harness = await start();
  const token = await harness.mint();
  const approvalId = String((await openPullRequest(harness, token)).json()['approval_id']);
  await harness.admin('POST', `/api/v1/approvals/${approvalId}/approve`);

  expect((await openPullRequest(harness, token, approvalId)).statusCode).toBe(201);
  const reuse = await openPullRequest(harness, token, approvalId);

  expect(reuse.statusCode).toBe(403);
  expect(reuse.json()).toMatchObject({
    error: 'agentgate_access_denied',
    decision: 'DENY',
    reason: `approval ${approvalId} has already been used`,
  });
  expect(harness.upstreamRequests).toHaveLength(1);

  expect(await auditRowFor(harness, requestIdOf(reuse))).toMatchObject({
    decision: 'DENY',
    matchedPolicy: 'approval-consumed',
    approvalId,
  });

  // A refused consume asks nobody anything: the record it failed against is the only one.
  expect(await harness.prisma.approval.count({ where: { missionId: harness.missionId } })).toBe(1);
});

test('two retries racing on one grant: exactly one reaches the upstream', async () => {
  const harness = await start();
  const token = await harness.mint();
  const approvalId = String((await openPullRequest(harness, token)).json()['approval_id']);
  await harness.admin('POST', `/api/v1/approvals/${approvalId}/approve`);

  const [first, second] = await Promise.all([
    openPullRequest(harness, token, approvalId),
    openPullRequest(harness, token, approvalId),
  ]);

  expect([first.statusCode, second.statusCode].sort((a, b) => a - b)).toEqual([201, 403]);
  expect(harness.upstreamRequests).toHaveLength(1);
});

const TWO_GATED_ACTIONS: MissionPermissions = {
  ...DEFAULT_PERMISSIONS,
  approvalActions: ['pull_request.create', 'branch.create'],
};

const TWO_GATED_ROUTES: NetworkRules = {
  allow: [
    { host: 'api.github.com', path: '/repos/acme/payments/pulls', methods: ['POST'] },
    { host: 'api.github.com', path: '/repos/acme/payments/git/refs', methods: ['POST'] },
  ],
  deny: [],
};

test('a grant for one action authorises nothing else', async () => {
  const harness = await start({ permissions: TWO_GATED_ACTIONS, network: TWO_GATED_ROUTES });
  const token = await harness.mint();
  const approvalId = String((await openPullRequest(harness, token)).json()['approval_id']);
  await harness.admin('POST', `/api/v1/approvals/${approvalId}/approve`);

  // Same mission, same agent, same repository — a different action, which is the whole point:
  // one approval never becomes a general permission.
  const borrowed = await harness.proxy(
    {
      credential: harness.alias,
      method: 'POST',
      url: 'https://api.github.com/repos/acme/payments/git/refs',
      headers: { 'Content-Type': 'application/json' },
      body: '{"ref":"refs/heads/fix-423"}',
      approvalId,
    },
    token,
  );

  expect(borrowed.statusCode).toBe(403);
  expect(borrowed.json()).toMatchObject({
    reason: `approval ${approvalId} does not authorise this request`,
  });
  expect(harness.upstreamRequests).toHaveLength(0);

  expect(await auditRowFor(harness, requestIdOf(borrowed))).toMatchObject({
    decision: 'DENY',
    action: 'branch.create',
    matchedPolicy: 'approval-mismatch',
    approvalId,
  });

  // Untouched: the failed attempt neither spent it nor queued a second question.
  expect(
    (await harness.prisma.approval.findUniqueOrThrow({ where: { id: approvalId } })).status,
  ).toBe('approved');
  expect(await harness.prisma.approval.count({ where: { missionId: harness.missionId } })).toBe(1);
});

test('a grant older than its five minutes is refused, and the record says so', async () => {
  const harness = await start();
  const token = await harness.mint();
  const approvalId = String((await openPullRequest(harness, token)).json()['approval_id']);
  await harness.admin('POST', `/api/v1/approvals/${approvalId}/approve`);

  harness.clock.now = new Date(harness.clock.now.getTime() + APPROVAL_GRANT_TTL_MS + 1);

  const late = await openPullRequest(harness, token, approvalId);

  expect(late.statusCode).toBe(403);
  expect(late.json()).toMatchObject({ reason: `approval ${approvalId} has expired` });
  expect(harness.upstreamRequests).toHaveLength(0);
  expect(await auditRowFor(harness, requestIdOf(late))).toMatchObject({
    matchedPolicy: 'approval-expired',
    approvalId,
  });
  expect(
    (await harness.prisma.approval.findUniqueOrThrow({ where: { id: approvalId } })).status,
  ).toBe('expired');
});

test('a denied approval is a no, and stays a no on every retry', async () => {
  const harness = await start();
  const token = await harness.mint();
  const approvalId = String((await openPullRequest(harness, token)).json()['approval_id']);

  const decision = await harness.admin('POST', `/api/v1/approvals/${approvalId}/deny`);
  expect(decision.statusCode).toBe(200);
  expect(decision.json()).toMatchObject({ status: 'denied', decidedBy: 'admin' });

  expect((await harness.approvalStatus(approvalId, token)).json()).toMatchObject({
    status: 'denied',
  });

  const retry = await openPullRequest(harness, token, approvalId);
  expect(retry.statusCode).toBe(403);
  expect(retry.json()).toMatchObject({ reason: `approval ${approvalId} has not been approved` });
  expect(harness.upstreamRequests).toHaveLength(0);
  expect(await auditRowFor(harness, requestIdOf(retry))).toMatchObject({
    matchedPolicy: 'approval-not-approved',
    approvalId,
  });
});

test('an approval id nobody issued is refused without creating anything', async () => {
  const harness = await start();
  const token = await harness.mint();

  const response = await openPullRequest(harness, token, 'apr_invented_by_the_agent');

  expect(response.statusCode).toBe(403);
  // Same sentence a grant belonging to someone else gets: whether the id exists is not
  // something the caller is told.
  expect(response.json()).toMatchObject({
    reason: 'approval apr_invented_by_the_agent does not authorise this request',
  });
  expect(await auditRowFor(harness, requestIdOf(response))).toMatchObject({
    matchedPolicy: 'approval-unknown',
    approvalId: 'apr_invented_by_the_agent',
  });
  expect(await harness.prisma.approval.count({ where: { missionId: harness.missionId } })).toBe(0);
});

test('an agent cannot read an approval belonging to another mission', async () => {
  const owner = await start();
  const stranger = await start();
  const approvalId = String(
    (await openPullRequest(owner, await owner.mint())).json()['approval_id'],
  );

  const peek = await owner.approvalStatus(approvalId, await stranger.mint());

  expect(peek.statusCode).toBe(404);
  expect(peek.json()).toMatchObject({ error: 'agentgate_not_found' });
});

test('the approval status route wants an agent token like every other enforcement route', async () => {
  const harness = await start();
  const approvalId = String(
    (await openPullRequest(harness, await harness.mint())).json()['approval_id'],
  );

  expect((await harness.approvalStatus(approvalId, 'not-even-a-jwt')).statusCode).toBe(401);
  expect(
    (await harness.app.inject({ method: 'GET', url: `/v1/approvals/${approvalId}` })).statusCode,
  ).toBe(401);
});

const MANAGEMENT_ROUTES = [
  ['GET', '/api/v1/approvals'],
  ['POST', '/api/v1/approvals/apr_anything/approve'],
  ['POST', '/api/v1/approvals/apr_anything/deny'],
] as const;

test.each(MANAGEMENT_ROUTES)('%s %s is refused without the admin token', async (method, url) => {
  const harness = await start();

  for (const token of [undefined, 'wrong-admin-token', '']) {
    const response = await harness.admin(method, url, { token });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'agentgate_invalid_token' });
  }

  // The agent's own token is not an admin token, whatever else it opens.
  const asAgent = await harness.admin(method, url, { token: await harness.mint() });
  expect(asAgent.statusCode).toBe(401);
});

test('the admin token never reaches a log line, accepted or refused', async () => {
  const harness = await start();

  await harness.admin('GET', '/api/v1/approvals');
  await harness.admin('GET', '/api/v1/approvals', { token: undefined });

  expect(harness.logLines.join('\n')).not.toContain(ADMIN_TOKEN);
});

test('the management list answers with what is waiting, filtered by status and mission', async () => {
  const harness = await start();
  const token = await harness.mint();
  const approvalId = String((await openPullRequest(harness, token)).json()['approval_id']);

  const pending = await harness.admin(
    'GET',
    `/api/v1/approvals?status=pending&missionId=${harness.missionId}`,
  );
  expect(pending.statusCode).toBe(200);
  expect(pending.json()['approvals']).toMatchObject([
    {
      id: approvalId,
      missionId: harness.missionId,
      agentId: harness.agentId,
      status: 'pending',
      action: 'pull_request.create',
      requestSummary: { method: 'POST', host: 'api.github.com' },
      decidedAt: null,
      grantExpiresAt: null,
    },
  ]);

  await harness.admin('POST', `/api/v1/approvals/${approvalId}/approve`);
  const stillPending = await harness.admin(
    'GET',
    `/api/v1/approvals?status=pending&missionId=${harness.missionId}`,
  );
  expect(stillPending.json()['approvals']).toEqual([]);
});

test('the management routes refuse what they cannot make sense of', async () => {
  const harness = await start();

  expect((await harness.admin('GET', '/api/v1/approvals?status=maybe')).statusCode).toBe(400);
  expect((await harness.admin('POST', '/api/v1/approvals/apr_nobody/approve')).statusCode).toBe(
    404,
  );

  const token = await harness.mint();
  const approvalId = String((await openPullRequest(harness, token)).json()['approval_id']);
  await harness.admin('POST', `/api/v1/approvals/${approvalId}/deny`);

  const second = await harness.admin('POST', `/api/v1/approvals/${approvalId}/approve`);
  expect(second.statusCode).toBe(409);
  expect(second.json()).toMatchObject({ error: 'agentgate_validation_error' });
});
