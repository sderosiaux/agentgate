import { afterEach, expect, test } from 'vitest';
import { DEFAULT_LIMITS, startHarness, type Harness } from './helpers/gateway.js';

let harness: Harness;

afterEach(async () => {
  await harness.close();
});

const READ_PAYMENTS = {
  method: 'GET',
  url: 'https://api.github.com/repos/acme/payments',
} as const;

function read(current: Harness, token: string) {
  return current.proxy({ credential: current.alias, ...READ_PAYMENTS }, token);
}

test('the request after the mission budget is spent answers 429', async () => {
  harness = await startHarness({ limits: { ...DEFAULT_LIMITS, maxRequests: 2 } });
  const token = await harness.mint();

  const first = await read(harness, token);
  const second = await read(harness, token);
  const third = await read(harness, token);

  expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
  expect(third.statusCode).toBe(429);
  expect(third.json()).toMatchObject({
    error: 'agentgate_limit_exceeded',
    decision: 'DENY',
  });
  // Two forwards, three attempts: the refused one never reached the upstream.
  expect(harness.upstreamRequests).toHaveLength(2);
});

test('a refused request still spends its slot', async () => {
  harness = await startHarness({ limits: { ...DEFAULT_LIMITS, maxRequests: 2 } });
  const token = await harness.mint();

  // Denied by the mission scope, and charged for all the same (D8).
  await harness.proxy(
    { credential: harness.alias, method: 'GET', url: 'https://api.github.com/repos/acme/other' },
    token,
  );
  await read(harness, token);
  const third = await read(harness, token);

  expect(third.statusCode).toBe(429);
});

test('the per-minute window refuses the extra request and reopens on the next minute', async () => {
  // A fixed clock, so the three calls provably land in the same window rather than usually
  // landing there. The mission outlives it by a wide margin.
  harness = await startHarness({
    limits: { ...DEFAULT_LIMITS, requestsPerMinute: 2 },
    now: new Date('2026-09-01T10:20:30.000Z'),
    expiresAt: new Date('2026-12-31T00:00:00.000Z'),
  });
  const token = await harness.mint();

  await read(harness, token);
  await read(harness, token);
  const third = await read(harness, token);

  expect(third.statusCode).toBe(429);
  expect(third.json()['reason']).toMatch(/per minute/);

  harness.clock.now = new Date('2026-09-01T10:21:00.000Z');
  expect((await read(harness, token)).statusCode).toBe(200);
});

test('the byte budget is enforced on what has already been moved', async () => {
  harness = await startHarness({ limits: { ...DEFAULT_LIMITS, maxBytes: 200 } });
  const token = await harness.mint();

  const first = await read(harness, token);
  const second = await read(harness, token);

  expect(first.statusCode).toBe(200);
  expect(Buffer.byteLength(first.body, 'utf8')).toBeGreaterThan(200);
  expect(second.statusCode).toBe(429);
  expect(second.json()['reason']).toMatch(/byte/);
});

test('a request body larger than what is left of the budget is refused before it is sent', async () => {
  harness = await startHarness({
    limits: { ...DEFAULT_LIMITS, maxBytes: 50 },
    network: {
      allow: [{ host: 'api.github.com', path: '/repos/acme/payments/pulls', methods: ['POST'] }],
      deny: [],
    },
    permissions: {
      resources: ['github:acme/payments'],
      allowedActions: ['pull_request.create'],
      approvalActions: [],
      deniedActions: [],
    },
  });
  const token = await harness.mint();

  const response = await harness.proxy(
    {
      credential: harness.alias,
      method: 'POST',
      url: 'https://api.github.com/repos/acme/payments/pulls',
      headers: { 'Content-Type': 'application/json' },
      body: `{"title":"${'x'.repeat(100)}"}`,
    },
    token,
  );

  expect(response.statusCode).toBe(429);
  expect(harness.upstreamRequests).toHaveLength(0);
});

test('ten requests racing for three slots hand out exactly three', async () => {
  harness = await startHarness({ limits: { ...DEFAULT_LIMITS, maxRequests: 3 } });
  const token = await harness.mint();

  const responses = await Promise.all(Array.from({ length: 10 }, () => read(harness, token)));

  expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(3);
  expect(responses.filter((response) => response.statusCode === 429)).toHaveLength(7);
  expect(harness.upstreamRequests).toHaveLength(3);
});

test('every attempt leaves exactly one audit row, allowed or not', async () => {
  harness = await startHarness({ limits: { ...DEFAULT_LIMITS, maxRequests: 1 } });
  const token = await harness.mint();

  await read(harness, token);
  await read(harness, token);
  const unidentified = await harness.proxy(
    { credential: harness.alias, ...READ_PAYMENTS },
    'not-a-token',
  );
  await harness.proxy({ nonsense: true }, token);

  const rows = await harness.prisma.auditEvent.findMany({
    where: { missionId: harness.missionId },
  });

  // Three attempts carried a usable identity: one allowed, one out of budget, one malformed.
  expect(rows).toHaveLength(3);
  expect(rows.map((row) => row.decision).sort()).toEqual(['ALLOW', 'DENY', 'DENY']);

  // …and the fourth, which never got past its token, is recorded with no identity at all.
  const anonymous = await harness.prisma.auditEvent.findMany({
    where: { requestId: String(unidentified.json()['request_id']) },
  });
  expect(anonymous).toHaveLength(1);
  expect(anonymous[0]).toMatchObject({ missionId: null, method: null, decision: 'DENY' });
});
