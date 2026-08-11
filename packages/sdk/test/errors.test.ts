import { afterEach, describe, expect, it } from 'vitest';
import {
  AccessDeniedError,
  AgentGate,
  GatewayError,
  InvalidTokenError,
  LimitExceededError,
} from '../src/index.js';
import { DEFAULT_LIMITS, startHarness, type Harness } from './helpers/harness.js';

const ISSUE_URL = 'https://api.github.com/repos/acme/payments/issues/423';

/** The proxy route's own ceiling, above which the framework stops reading (8 MiB). */
const OVER_THE_BODY_LIMIT = 'x'.repeat(9 * 1024 * 1024);

describe('what the SDK throws for each refusal', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it('403 outside the mission scope is an AccessDeniedError carrying the reason', async () => {
    harness = await startHarness();

    const failure = await harness.gate
      .request({
        credential: harness.alias,
        method: 'GET',
        url: 'https://api.github.com/repos/acme/secret-project',
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AccessDeniedError);
    const denied = failure as AccessDeniedError;
    expect(denied.status).toBe(403);
    expect(denied.decision).toBe('DENY');
    expect(denied.reason).toBe(denied.message);
    expect(denied.reason.length).toBeGreaterThan(0);
    expect(denied.requestId).toMatch(/^req_/);
  });

  it('403 on an expired mission is an AccessDeniedError, told apart by its code', async () => {
    harness = await startHarness({ expiresAt: new Date(Date.now() - 1_000) });

    const failure = await harness.gate
      .request({ credential: harness.alias, method: 'GET', url: ISSUE_URL })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AccessDeniedError);
    expect((failure as AccessDeniedError).code).toBe('agentgate_mission_expired');
  });

  it('401 is an InvalidTokenError', async () => {
    harness = await startHarness();
    const gate = new AgentGate({ gatewayUrl: harness.baseUrl, token: 'not-a-signed-token' });

    await expect(
      gate.request({ credential: harness.alias, method: 'GET', url: ISSUE_URL }),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('429 over the mission budget is a LimitExceededError', async () => {
    harness = await startHarness({ limits: { ...DEFAULT_LIMITS, maxRequests: 1 } });

    await harness.gate.request({ credential: harness.alias, method: 'GET', url: ISSUE_URL });

    await expect(
      harness.gate.request({ credential: harness.alias, method: 'GET', url: ISSUE_URL }),
    ).rejects.toBeInstanceOf(LimitExceededError);
  });

  it('400 on an envelope the gateway will not read is a GatewayError', async () => {
    harness = await startHarness();

    const failure = await harness.gate
      .request({ credential: 'a'.repeat(200), method: 'GET', url: ISSUE_URL })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GatewayError);
    expect((failure as GatewayError).status).toBe(400);
  });

  it('413 on a body past the gateway limit is a GatewayError', async () => {
    harness = await startHarness();

    const failure = await harness.gate
      .request({
        credential: harness.alias,
        method: 'POST',
        url: 'https://api.github.com/repos/acme/payments/pulls',
        headers: { 'content-type': 'application/json' },
        body: OVER_THE_BODY_LIMIT,
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GatewayError);
    expect((failure as GatewayError).status).toBe(413);
  });

  it('502 from an upstream that is not there is a GatewayError', async () => {
    // Nothing listens on port 1, so the forward fails after the request was allowed.
    harness = await startHarness({ upstreamBaseUrl: 'http://127.0.0.1:1' });

    const failure = await harness.gate
      .request({ credential: harness.alias, method: 'GET', url: ISSUE_URL })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GatewayError);
    expect((failure as GatewayError).status).toBe(502);
    expect((failure as GatewayError).code).toBe('agentgate_upstream_error');
  });

  it('a credential the mission cannot use is refused without saying which of the reasons', async () => {
    harness = await startHarness();

    const failure = await harness.gate
      .request({ credential: 'no_such_alias', method: 'GET', url: ISSUE_URL })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AccessDeniedError);
    expect((failure as AccessDeniedError).code).toBe('agentgate_unknown_credential');
  });
});
