// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAction } from '@/lib/route-handler';

/**
 * The route handlers are what a button reaches, and they carry the admin token's authority
 * without asking the caller for anything. That makes them the console's cross-site attack
 * surface: a page an operator merely visits must not be able to drive them.
 *
 * The threat is not hypothetical here. A compromised agent is handed its own `approval_id` in
 * the 202 it gets back, so if it can make an operator's browser issue one request it approves
 * its own pending action — which is precisely the human decision D7 exists to require.
 */

const CONSOLE = 'http://console.local';
const ENDPOINT = `${CONSOLE}/api/approvals/apr_1/approve`;

function post(headers: Record<string, string>): Request {
  return new Request(ENDPOINT, {
    method: 'POST',
    headers: { host: 'console.local', ...headers },
    body: '{}',
  });
}

const JSON_TYPE = { 'content-type': 'application/json' };

let work: ReturnType<typeof vi.fn>;

beforeEach(() => {
  work = vi.fn().mockResolvedValue({ id: 'apr_1', status: 'approved' });
});

describe('cross-site protection on the action routes', () => {
  it('refuses a content type a cross-origin form could send', async () => {
    // The whole form-CSRF class dies here: a <form> can only emit urlencoded, multipart or
    // plain text, and none of them is this. A JSON fetch, by contrast, is preflighted — and
    // this console answers no preflight.
    const response = await runAction(
      post({
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'http://evil.example',
      }),
      work,
    );

    expect(response.status).toBe(415);
    expect(work).not.toHaveBeenCalled();
  });

  it('refuses a request that announces no content type at all', async () => {
    const response = await runAction(post({ origin: 'http://evil.example' }), work);

    expect(response.status).toBe(415);
    expect(work).not.toHaveBeenCalled();
  });

  it('refuses a foreign origin even when the content type is right', async () => {
    // Defence in depth, for a caller that is not a browser and therefore not bound by
    // preflight rules.
    const response = await runAction(post({ ...JSON_TYPE, origin: 'http://evil.example' }), work);

    expect(response.status).toBe(403);
    expect(work).not.toHaveBeenCalled();
  });

  it('refuses an origin it cannot even parse', async () => {
    const response = await runAction(post({ ...JSON_TYPE, origin: 'not-a-url' }), work);

    expect(response.status).toBe(403);
    expect(work).not.toHaveBeenCalled();
  });

  it('says why it refused, in the shape every other refusal uses', async () => {
    const response = await runAction(post({ ...JSON_TYPE, origin: 'http://evil.example' }), work);
    const body = (await response.json()) as { error: string; reason: string };

    expect(body.error).toBe('agentgate_forbidden');
    expect(body.reason).toContain('origin');
  });

  it('lets the console’s own call through', async () => {
    const response = await runAction(post({ ...JSON_TYPE, origin: CONSOLE }), work);

    expect(response.status).toBe(200);
    expect(work).toHaveBeenCalledTimes(1);
    expect(await response.json()).toEqual({ id: 'apr_1', status: 'approved' });
  });

  it('lets a same-origin call with no Origin header through', async () => {
    // Same-origin POSTs do not always carry Origin, depending on the browser and the fetch.
    const response = await runAction(post(JSON_TYPE), work);

    expect(response.status).toBe(200);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('accepts the external name when a proxy rewrote Host to an internal one', async () => {
    // Without this the console would answer 403 to its own buttons behind any reverse proxy.
    const response = await runAction(
      post({
        ...JSON_TYPE,
        host: 'web:3000',
        'x-forwarded-host': 'console.example.com',
        origin: 'https://console.example.com',
      }),
      work,
    );

    expect(response.status).toBe(200);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('does not let a forwarded name vouch for an origin that matches neither', async () => {
    const response = await runAction(
      post({
        ...JSON_TYPE,
        host: 'web:3000',
        'x-forwarded-host': 'console.example.com',
        origin: 'https://evil.example',
      }),
      work,
    );

    expect(response.status).toBe(403);
    expect(work).not.toHaveBeenCalled();
  });

  it('accepts the content type with a charset parameter', async () => {
    const response = await runAction(
      post({ 'content-type': 'application/json; charset=utf-8' }),
      work,
    );

    expect(response.status).toBe(200);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('still passes the gateway’s own refusal back once the checks are satisfied', async () => {
    const { GatewayError } = await import('@/lib/api');
    work.mockRejectedValue(
      new GatewayError(409, 'approval apr_1 is denied', 'agentgate_validation_error'),
    );

    const response = await runAction(post(JSON_TYPE), work);
    const body = (await response.json()) as { error: string; reason: string };

    expect(response.status).toBe(409);
    expect(body.reason).toBe('approval apr_1 is denied');
  });
});
