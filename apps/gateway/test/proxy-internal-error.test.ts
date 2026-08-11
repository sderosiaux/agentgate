import type { PolicyEngine } from '@agentgate/policy';
import { afterEach, expect, test } from 'vitest';
import { startHarness, type Harness } from './helpers/gateway.js';

let harness: Harness;

afterEach(async () => {
  await harness.close();
});

/**
 * The shape of a bug: something in the decision path throws for a reason nobody anticipated.
 * A policy engine is the cheapest place to inject one, and it sits deep enough in the pipeline
 * that the attempt is fully identified by the time it fails — which is the case that matters.
 */
const CAUSE = 'the policy engine tripped over its own shoelaces';

const brokenEngine: PolicyEngine = {
  async evaluate() {
    throw new Error(CAUSE);
  },
};

const READ_ISSUE = {
  method: 'GET',
  url: 'https://api.github.com/repos/acme/payments/issues/423',
} as const;

test('an unexpected throw is answered as an internal error, never as an upstream one', async () => {
  harness = await startHarness({ engine: brokenEngine });
  const token = await harness.mint();

  const response = await harness.proxy({ ...READ_ISSUE, credential: harness.alias }, token);

  expect(response.statusCode).toBe(500);
  expect(response.json()).toMatchObject({
    error: 'agentgate_internal_error',
    reason: 'the gateway could not answer',
  });
  // No `decision`: nothing was decided. An `agentgate_upstream_error` here would have said a
  // third party failed, which is a different thing to investigate and a different thing to
  // retry — the SDK and the console both branch on this code.
  expect(response.json()['decision']).toBeUndefined();
});

test('the agent is told nothing about the cause, and neither is the trail', async () => {
  harness = await startHarness({ engine: brokenEngine });
  const token = await harness.mint();

  const response = await harness.proxy({ ...READ_ISSUE, credential: harness.alias }, token);

  expect(response.body).not.toContain(CAUSE);
  expect(response.body).not.toContain('shoelaces');

  const rows = await harness.prisma.auditEvent.findMany({
    where: { missionId: harness.missionId },
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ decision: 'ERROR', reason: 'the gateway could not answer' });
  // The audit table is append-only and readable through the management API: a stack trace in
  // it would be indelible, and a stack trace carries whatever the frame variables carried.
  expect(JSON.stringify(rows[0])).not.toContain(CAUSE);
});

test('the cause reaches the server log, which is the only place it exists', async () => {
  harness = await startHarness({ engine: brokenEngine });
  const token = await harness.mint();

  const response = await harness.proxy({ ...READ_ISSUE, credential: harness.alias }, token);

  const logged = harness.logLines.join('');
  expect(logged).toContain(CAUSE);
  // Tied to the attempt it explains. Without this the line is a stack trace nobody can match to
  // the 500 a caller is complaining about.
  expect(logged).toContain(String(response.json()['request_id']));
});

test('a refusal the gateway stands behind still logs no stack and stays a decision', async () => {
  // The control. Everything above must not have turned ordinary denials into internal errors:
  // a DENY is an answer, and answering it with a 500 would hide policy behind an outage.
  harness = await startHarness();
  const token = await harness.mint();

  const response = await harness.proxy(
    {
      method: 'GET',
      url: 'https://api.github.com/repos/acme/secret-project',
      credential: harness.alias,
    },
    token,
  );

  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({ decision: 'DENY' });
  expect(harness.logLines.join('')).not.toContain('proxy attempt failed unexpectedly');
});
