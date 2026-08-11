import { afterEach, expect, test } from 'vitest';
import { startHarness, UPSTREAM_TOKEN, type Harness } from './helpers/gateway.js';

let harness: Harness;

afterEach(async () => {
  await harness.close();
});

const READ_PAYMENTS = {
  method: 'GET',
  url: 'https://api.github.com/repos/acme/payments',
} as const;

test('an allowed request leaves the credential in none of the logs', async () => {
  harness = await startHarness();
  const token = await harness.mint();

  const response = await harness.proxy({ credential: harness.alias, ...READ_PAYMENTS }, token);

  expect(response.statusCode).toBe(200);
  expect(harness.logLines.length).toBeGreaterThan(0);
  expect(harness.logLines.join('')).not.toContain(UPSTREAM_TOKEN);
});

test('the credential never reaches the response the agent gets', async () => {
  harness = await startHarness();
  const token = await harness.mint();

  const response = await harness.proxy({ credential: harness.alias, ...READ_PAYMENTS }, token);

  expect(response.body).not.toContain(UPSTREAM_TOKEN);
  expect(JSON.stringify(response.headers)).not.toContain(UPSTREAM_TOKEN);
});

test('the credential never reaches the audit trail', async () => {
  harness = await startHarness();
  const token = await harness.mint();

  await harness.proxy({ credential: harness.alias, ...READ_PAYMENTS }, token);

  const rows = await harness.prisma.auditEvent.findMany({
    where: { missionId: harness.missionId },
  });

  expect(JSON.stringify(rows)).not.toContain(UPSTREAM_TOKEN);
});

test("the agent's own token is not in the logs either", async () => {
  harness = await startHarness();
  const token = await harness.mint();

  await harness.proxy({ credential: harness.alias, ...READ_PAYMENTS }, token);

  expect(harness.logLines.join('')).not.toContain(token);
});

test('a credential embedded in an error message is scrubbed out of the log line', async () => {
  harness = await startHarness();
  const token = await harness.mint();
  // The first request is what teaches the scrubber this value: nothing is registered before
  // the store has decrypted something.
  await harness.proxy({ credential: harness.alias, ...READ_PAYMENTS }, token);

  harness.app.log.error(
    { err: new Error(`upstream refused ${UPSTREAM_TOKEN}`) },
    `while presenting ${UPSTREAM_TOKEN}`,
  );

  const written = harness.logLines.join('');
  expect(written).not.toContain(UPSTREAM_TOKEN);
  expect(written).toContain('[REDACTED]');
});

test('a failed request logs the refusal without the credential or the agent token', async () => {
  harness = await startHarness({ upstreamBaseUrl: 'http://127.0.0.1:1' });
  const token = await harness.mint();

  const response = await harness.proxy({ credential: harness.alias, ...READ_PAYMENTS }, token);

  expect(response.statusCode).toBe(502);
  const written = harness.logLines.join('');
  expect(written).not.toContain(UPSTREAM_TOKEN);
  expect(written).not.toContain(token);
});
