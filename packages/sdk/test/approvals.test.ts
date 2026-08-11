import { afterEach, describe, expect, it } from 'vitest';
import {
  AccessDeniedError,
  AgentGateSdkError,
  ApprovalNotGrantedError,
  ApprovalRequiredError,
  ApprovalTimeoutError,
  type ProxyRequest,
} from '../src/index.js';
import { startHarness, type Harness } from './helpers/harness.js';

const PULL_REQUEST: Omit<ProxyRequest, 'credential'> = {
  method: 'POST',
  url: 'https://api.github.com/repos/acme/payments/pulls',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'Add idempotency key to the webhook handler' }),
};

/** The 202 an agent gets the first time it asks for something a human has to allow. */
async function askForApproval(harness: Harness): Promise<ApprovalRequiredError> {
  const failure = await harness.gate
    .request({ credential: harness.alias, ...PULL_REQUEST })
    .catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(ApprovalRequiredError);

  return failure as ApprovalRequiredError;
}

describe('the approval round trip', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it('asks, waits, retries with the grant, and cannot spend it twice', async () => {
    harness = await startHarness();

    const required = await askForApproval(harness);
    expect(required.approvalId).toMatch(/^apr_/);
    expect(required.status).toBe(202);
    expect(required.decision).toBe('REQUIRE_APPROVAL');
    expect(required.requestId).toMatch(/^req_/);

    const pending = await harness.gate.getApproval(required.approvalId);
    expect(pending).toMatchObject({
      id: required.approvalId,
      status: 'pending',
      resource: 'github:acme/payments',
      action: 'pull_request.create',
    });

    const approved = await harness.admin(
      'POST',
      `/api/v1/approvals/${required.approvalId}/approve`,
      { decidedBy: 'sdk-test' },
    );
    expect(approved.status).toBe(200);

    await harness.gate.waitForApproval(required.approvalId, {
      timeoutMs: 5_000,
      intervalMs: 50,
    });

    const response = await harness.gate.request({
      credential: harness.alias,
      ...PULL_REQUEST,
      approvalId: required.approvalId,
    });
    expect(response.status).toBe(201);
    expect(response.json<{ number: number; title: string }>()).toMatchObject({
      number: 991,
      title: 'Add idempotency key to the webhook handler',
    });

    // The same grant a second time: single use, so this is a denial and not a second pull
    // request (D7).
    const reused = await harness.gate
      .request({ credential: harness.alias, ...PULL_REQUEST, approvalId: required.approvalId })
      .catch((error: unknown) => error);

    expect(reused).toBeInstanceOf(AccessDeniedError);
    expect((reused as AccessDeniedError).reason).toContain('already been used');

    // And waiting on it again says which of the ways it is unusable, without anyone having to
    // read a sentence to find out.
    const spent = await harness.gate
      .waitForApproval(required.approvalId, { timeoutMs: 5_000, intervalMs: 50 })
      .catch((error: unknown) => error);

    expect(spent).toBeInstanceOf(ApprovalNotGrantedError);
    expect((spent as ApprovalNotGrantedError).approvalStatus).toBe('consumed');
  });

  it('throws when the human said no', async () => {
    harness = await startHarness();

    const required = await askForApproval(harness);
    const denied = await harness.admin('POST', `/api/v1/approvals/${required.approvalId}/deny`, {});
    expect(denied.status).toBe(200);

    const failure = await harness.gate
      .waitForApproval(required.approvalId, { timeoutMs: 5_000, intervalMs: 50 })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApprovalNotGrantedError);
    // Still an AccessDeniedError, so an agent that only wants "I may not proceed" is unaffected.
    expect(failure).toBeInstanceOf(AccessDeniedError);
    expect((failure as ApprovalNotGrantedError).approvalStatus).toBe('denied');
  });

  it('gives up rather than polling forever', async () => {
    harness = await startHarness();

    const required = await askForApproval(harness);

    const failure = await harness.gate
      .waitForApproval(required.approvalId, { timeoutMs: 300, intervalMs: 50 })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApprovalTimeoutError);
    expect(failure).toBeInstanceOf(AgentGateSdkError);
    expect((failure as AgentGateSdkError).code).toBe('agentgate_sdk_approval_timeout');
  });

  it('answers 404 for an approval that belongs to another mission', async () => {
    harness = await startHarness();
    const other = await startHarness();

    try {
      const required = await askForApproval(other);

      const failure = await harness.gate
        .getApproval(required.approvalId)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AgentGateSdkError);
      expect((failure as AgentGateSdkError).status).toBe(404);
    } finally {
      await other.close();
    }
  });
});
