import { afterEach, expect, test } from 'vitest';
import { RESPONSE_SLACK_BYTES } from '../src/enforcement/limits.js';
import { startEchoUpstream, type EchoUpstream } from './helpers/echo-upstream.js';
import { DEFAULT_LIMITS, startHarness, type Harness } from './helpers/gateway.js';

let harness: Harness;
let echo: EchoUpstream | undefined;

afterEach(async () => {
  await harness.close();
  await echo?.close();
  echo = undefined;
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

test('a malformed envelope from an authenticated agent costs a slot like any other', async () => {
  // Otherwise probing the gateway with garbage is free, and every free attempt still writes a
  // row to an append-only table: the cheapest denial-of-wallet there is.
  harness = await startHarness();
  const token = await harness.mint();

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await harness.proxy({ garbage: attempt }, token);
    expect(response.statusCode).toBe(400);
  }

  const counter = await harness.prisma.usageCounter.findUniqueOrThrow({
    where: { missionId: harness.missionId },
  });
  expect(counter.requestCount).toBe(4);
});

test('a mission out of budget is refused before its envelope is even read', async () => {
  harness = await startHarness({ limits: { ...DEFAULT_LIMITS, maxRequests: 1 } });
  const token = await harness.mint();

  await read(harness, token);
  const response = await harness.proxy({ garbage: true }, token);

  // The budget is spent, so the answer is about the budget — not a critique of a body the
  // gateway was never going to act on.
  expect(response.statusCode).toBe(429);
  expect(response.json()).toMatchObject({ error: 'agentgate_limit_exceeded' });
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

test('a response the mission cannot afford is refused, and charged for what was read', async () => {
  // An upstream is not something the gateway gets to trust about size either: without a cap it
  // decides how much memory the gateway spends and how much text the secret scrub walks.
  echo = await startEchoUpstream();
  harness = await startHarness({
    upstreamBaseUrl: echo.baseUrl,
    limits: { ...DEFAULT_LIMITS, maxBytes: 1_000 },
  });
  const token = await harness.mint();
  const oversized = RESPONSE_SLACK_BYTES + 8_192;

  const response = await harness.proxy(
    {
      credential: harness.alias,
      method: 'GET',
      // The query picks the response size and never reaches policy, which matched the path.
      url: `https://api.github.com/repos/acme/payments?bytes=${String(oversized)}`,
    },
    token,
  );

  expect(response.statusCode).toBe(502);
  expect(response.json()).toMatchObject({ error: 'agentgate_upstream_error' });

  const [row] = await harness.prisma.auditEvent.findMany({
    where: { missionId: harness.missionId },
  });
  expect(row).toMatchObject({ decision: 'ERROR', httpStatus: 502 });

  // Charged for what crossed the network before the gateway stopped reading, and no further.
  const counter = await harness.prisma.usageCounter.findUniqueOrThrow({
    where: { missionId: harness.missionId },
  });
  expect(Number(counter.bytesTotal)).toBeGreaterThan(0);
  expect(Number(counter.bytesTotal)).toBeLessThanOrEqual(oversized);
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
