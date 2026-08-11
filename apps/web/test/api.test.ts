// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, describeError, GatewayError } from '@/lib/api';

const TOKEN = 'test-admin-token-DEV-ONLY';

let fetchMock: ReturnType<typeof vi.fn>;

function answer(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  process.env.ADMIN_TOKEN = TOKEN;
  process.env.GATEWAY_URL = 'http://gateway.test:8080';
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function lastCall(): [string, RequestInit] {
  return fetchMock.mock.calls.at(-1) as [string, RequestInit];
}

describe('the gateway client', () => {
  it('sends the admin token as a bearer, and never caches', async () => {
    fetchMock.mockResolvedValue(answer({ activeAgents: 1 }));

    await api.overview();

    const [url, init] = lastCall();
    expect(url).toBe('http://gateway.test:8080/api/v1/stats/overview');
    expect(init.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
    expect(init.cache).toBe('no-store');
  });

  it('posts `{}` on every action, because an empty JSON body is answered with 400', async () => {
    fetchMock.mockResolvedValue(answer({ id: 'apr_1' }));

    await api.approve('apr_1');
    expect(lastCall()[1].body).toBe('{}');
    expect(lastCall()[1].headers).toMatchObject({ 'content-type': 'application/json' });

    await api.deny('apr_1');
    expect(lastCall()[1].body).toBe('{}');

    await api.expireMission('mis_1');
    expect(lastCall()[0]).toBe('http://gateway.test:8080/api/v1/missions/mis_1/expire');
    expect(lastCall()[1].body).toBe('{}');

    fetchMock.mockResolvedValue(
      answer({ token: 'eyJ.secret.jwt', sessionId: 'ses_1', expiresAt: '2026-08-11T10:00:00Z' }),
    );
    await api.mintToken('mis_1');
    expect(lastCall()[1].body).toBe('{}');
  });

  it('drops a minted token instead of handing it back to the console', async () => {
    fetchMock.mockResolvedValue(
      answer({ token: 'eyJ.secret.jwt', sessionId: 'ses_1', expiresAt: '2026-08-11T10:00:00Z' }),
    );

    const minted = await api.mintToken('mis_1');

    expect(minted).toEqual({ sessionId: 'ses_1', expiresAt: '2026-08-11T10:00:00Z' });
    expect(JSON.stringify(minted)).not.toContain('eyJ.secret.jwt');
  });

  it('turns a refusal into an error carrying the gateway’s own reason', async () => {
    fetchMock.mockResolvedValue(
      answer(
        {
          error: 'agentgate_not_found',
          reason: 'mission mis_9 is unknown',
          request_id: 'req_9',
        },
        404,
      ),
    );

    const failure = await api.mission('mis_9').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GatewayError);
    expect((failure as GatewayError).status).toBe(404);
    expect((failure as GatewayError).code).toBe('agentgate_not_found');
    expect((failure as GatewayError).message).toContain('mis_9');
  });

  it('refuses to send an empty bearer when the console is not configured', async () => {
    delete process.env.ADMIN_TOKEN;

    const failure = await api.overview().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GatewayError);
    expect((failure as GatewayError).message).toContain('ADMIN_TOKEN');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads the two paginated lists under the names the API gives them', async () => {
    fetchMock.mockResolvedValue(answer({ events: [{ id: 'aud_1' }], nextCursor: 'aud_1' }));
    const trail = await api.audit({ decision: 'DENY', agentId: undefined, limit: 50 });

    expect(trail.items).toHaveLength(1);
    expect(trail.nextCursor).toBe('aud_1');
    // An undefined filter is left out of the query string entirely: the management API rejects
    // unknown or empty parameters rather than ignoring them.
    expect(lastCall()[0]).toBe('http://gateway.test:8080/api/v1/audit?decision=DENY&limit=50');

    fetchMock.mockResolvedValue(answer({ approvals: [{ id: 'apr_1' }], nextCursor: null }));
    const queue = await api.approvals({ status: 'pending' });

    expect(queue.items).toHaveLength(1);
    expect(queue.nextCursor).toBeNull();
  });

  it('never renders a connection URL, because that URL can carry a password', async () => {
    // GATEWAY_URL is a deployment value an operator may well have written credentials into,
    // and describeError's output is rendered into HTML the browser receives. Two ways it used
    // to escape: the configured URL itself, and undici's error message, which re-embeds it.
    process.env.GATEWAY_URL = 'http://admin:hunter2SECRET@127.0.0.1:9';
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(
        new Error('connect ECONNREFUSED http://admin:hunter2SECRET@127.0.0.1:9'),
        {
          code: 'ECONNREFUSED',
        },
      ),
    });
    fetchMock.mockRejectedValue(refused);

    const failure = await api.overview().catch((error: unknown) => error);
    const shown = describeError(failure);

    expect(shown).not.toContain('hunter2SECRET');
    expect(shown).not.toContain('admin:');
    expect(shown).not.toContain('fetch failed');
    // Still useful: the host it could not reach, and why.
    expect(shown).toContain('127.0.0.1:9');
    expect(shown).toContain('ECONNREFUSED');
  });

  it('finds the failure code however deeply the runtime wrapped it', async () => {
    process.env.GATEWAY_URL = 'http://admin:hunter2SECRET@127.0.0.1:9';
    const nested = new TypeError('fetch failed');
    (nested as { cause?: unknown }).cause = {
      message: 'connect to http://admin:hunter2SECRET@127.0.0.1:9 failed',
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), {
        code: 'ECONNREFUSED',
      }),
    };
    fetchMock.mockRejectedValue(nested);

    const shown = describeError(await api.overview().catch((error: unknown) => error));

    expect(shown).toBe('127.0.0.1:9 could not be reached (ECONNREFUSED)');
  });

  it('says nothing beyond the host when there is no code worth repeating', async () => {
    process.env.GATEWAY_URL = 'http://admin:hunter2SECRET@127.0.0.1:9';
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    expect(describeError(await api.overview().catch((error: unknown) => error))).toBe(
      '127.0.0.1:9 could not be reached',
    );
  });

  it('keeps the gateway’s own words when the gateway is the one refusing', async () => {
    fetchMock.mockResolvedValue(
      answer({ error: 'agentgate_invalid_token', reason: 'Admin token is invalid' }, 401),
    );

    const failure = await api.overview().catch((error: unknown) => error);

    expect(describeError(failure)).toBe('Admin token is invalid (HTTP 401)');
  });

  it('defaults to the compose address when GATEWAY_URL is not set', async () => {
    delete process.env.GATEWAY_URL;
    fetchMock.mockResolvedValue(answer({ credentials: [] }));

    await api.credentials();

    expect(lastCall()[0]).toBe('http://gateway:8080/api/v1/credentials');
  });
});
