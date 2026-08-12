import { afterEach, expect, test } from 'vitest';
import { RESPONSE_RESERVATION_CAP_BYTES, RESPONSE_SLACK_BYTES } from '../src/enforcement/limits.js';
import { startEchoUpstream, type EchoUpstream } from './helpers/echo-upstream.js';
import { DEFAULT_LIMITS, startHarness, type Harness } from './helpers/gateway.js';

let harness: Harness;
let echo: EchoUpstream | undefined;

afterEach(async () => {
  await harness.close();
  await echo?.close();
  echo = undefined;
});

/** The most a mission may end up over its budget: one request's worth of reservation. */
function ceiling(maxBytes: number): number {
  return maxBytes + RESPONSE_RESERVATION_CAP_BYTES + RESPONSE_SLACK_BYTES;
}

async function bytesSpent(current: Harness): Promise<number> {
  const counter = await current.prisma.usageCounter.findUniqueOrThrow({
    where: { missionId: current.missionId },
  });

  return Number(counter.bytesTotal);
}

test('concurrent requests cannot each spend the same remaining budget', async () => {
  // Every one of these reads the byte counter, finds the same room left, and asks for a
  // response allowance computed from it. Before the reservation they all got one: the budget
  // was handed out ten times over and the mission ended far past `maxBytes`.
  echo = await startEchoUpstream();
  const size = 40_000;
  harness = await startHarness({
    upstreamBaseUrl: echo.baseUrl,
    limits: { ...DEFAULT_LIMITS, maxBytes: 120_000 },
  });
  const token = await harness.mint();

  const responses = await Promise.all(
    Array.from({ length: 10 }, async () =>
      harness.proxy(
        {
          credential: harness.alias,
          method: 'GET',
          url: `https://api.github.com/repos/acme/payments?bytes=${String(size)}`,
        },
        token,
      ),
    ),
  );

  const allowed = responses.filter((response) => response.statusCode === 200);
  expect(allowed.length).toBeGreaterThan(0);
  expect(allowed.length).toBeLessThan(10);
  expect(responses.filter((response) => response.statusCode === 429).length).toBeGreaterThan(0);

  expect(await bytesSpent(harness)).toBeLessThanOrEqual(ceiling(120_000));
});

test('a budget with room for several reservations still runs them in parallel', async () => {
  // The other side of the trade-off, and the one that would be easy to lose: a reservation is
  // an upper bound, so a mission can only have as many requests in flight as its budget has
  // room to reserve. This pins that the bound is the budget and not one request at a time.
  echo = await startEchoUpstream();
  const room = 6;
  harness = await startHarness({
    upstreamBaseUrl: echo.baseUrl,
    limits: {
      ...DEFAULT_LIMITS,
      maxBytes: room * (RESPONSE_RESERVATION_CAP_BYTES + RESPONSE_SLACK_BYTES),
    },
  });
  const token = await harness.mint();

  const responses = await Promise.all(
    Array.from({ length: room }, async () =>
      harness.proxy(
        {
          credential: harness.alias,
          method: 'GET',
          url: 'https://api.github.com/repos/acme/payments?bytes=1000',
        },
        token,
      ),
    ),
  );

  expect(responses.map((response) => response.statusCode)).toEqual(Array<number>(room).fill(200));
});

test('a response larger than one reservation is cut off rather than charged silently', async () => {
  // The cap on the reservation is the cap on the read, so a mission is never charged for bytes
  // the gateway decided in advance it could not pay for. Driven from the remaining-budget side
  // rather than the 8 MiB cap: the arithmetic is the same and the payload is not eight
  // megabytes of `x` through a loopback socket. The cap itself is pinned in limits.test.ts.
  echo = await startEchoUpstream();
  const maxBytes = 100_000;
  harness = await startHarness({
    upstreamBaseUrl: echo.baseUrl,
    limits: { ...DEFAULT_LIMITS, maxBytes },
  });
  const token = await harness.mint();
  const oversized = maxBytes + RESPONSE_SLACK_BYTES + 8_192;

  const response = await harness.proxy(
    {
      credential: harness.alias,
      method: 'GET',
      url: `https://api.github.com/repos/acme/payments?bytes=${String(oversized)}`,
    },
    token,
  );

  expect(response.statusCode).toBe(502);
  expect(await bytesSpent(harness)).toBeLessThanOrEqual(maxBytes + RESPONSE_SLACK_BYTES);
});

test('a reservation is released down to what the request actually moved', async () => {
  // The reservation is an upper bound taken before the answer exists. If the unused part were
  // not given back, a mission would be charged the whole allowance for a 200-byte response and
  // its budget would be spent by arithmetic rather than by traffic.
  echo = await startEchoUpstream();
  harness = await startHarness({ upstreamBaseUrl: echo.baseUrl });
  const token = await harness.mint();

  const response = await harness.proxy(
    {
      credential: harness.alias,
      method: 'GET',
      url: 'https://api.github.com/repos/acme/payments?bytes=1000',
    },
    token,
  );

  expect(response.statusCode).toBe(200);
  const spent = await bytesSpent(harness);
  expect(spent).toBeGreaterThanOrEqual(1_000);
  expect(spent).toBeLessThan(2_000);
});

test('a forward that never answers releases everything but the body it sent', async () => {
  harness = await startHarness({ upstreamBaseUrl: 'http://127.0.0.1:1' });
  const token = await harness.mint();

  const response = await harness.proxy(
    {
      credential: harness.alias,
      method: 'GET',
      url: 'https://api.github.com/repos/acme/payments',
    },
    token,
  );

  expect(response.statusCode).toBe(502);
  // The request body was zero bytes, so a failed forward leaves the budget where it was rather
  // than holding a reservation nobody will ever release.
  expect(await bytesSpent(harness)).toBe(0);
});
