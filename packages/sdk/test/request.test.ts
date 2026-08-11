import { inspect } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentGate,
  AgentGateSdkError,
  MalformedResponseError,
  TransportError,
} from '../src/index.js';
import { startEchoUpstream, type EchoUpstream } from './helpers/echo-upstream.js';
import { startHarness, type Harness } from './helpers/harness.js';

const ISSUE_URL = 'https://api.github.com/repos/acme/payments/issues/423';

describe('AgentGate.request', () => {
  let harness: Harness | undefined;
  let echo: EchoUpstream | undefined;

  afterEach(async () => {
    await harness?.close();
    await echo?.close();
    harness = undefined;
    echo = undefined;
  });

  it('returns the upstream answer when the gateway allows the request', async () => {
    harness = await startHarness();

    const response = await harness.gate.request({
      credential: harness.alias,
      method: 'GET',
      url: ISSUE_URL,
    });

    expect(response.status).toBe(200);
    expect(response.json<{ number: number; title: string }>()).toMatchObject({
      number: 423,
      title: 'Payment webhook retries duplicate charges',
    });
    // The one header the gateway adds: what ties this answer to its audit row.
    expect(response.headers['x-agentgate-request-id']).toMatch(/^req_/);
    expect(response.headers['content-type']).toContain('application/json');
  });

  it('hands back an upstream failure instead of throwing: 404 is an answer', async () => {
    harness = await startHarness();

    const response = await harness.gate.request({
      credential: harness.alias,
      method: 'GET',
      url: 'https://api.github.com/repos/acme/payments/issues/999',
    });

    expect(response.status).toBe(404);
    expect(response.json<{ message: string }>().message).toBe('Not Found');
  });

  it('passes the agent headers the gateway forwards, and only those', async () => {
    echo = await startEchoUpstream();
    harness = await startHarness({ upstreamBaseUrl: echo.baseUrl });

    const response = await harness.gate.request({
      credential: harness.alias,
      method: 'GET',
      url: ISSUE_URL,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        // Not on the gateway's forward allowlist: the SDK sends it, the gateway drops it.
        'x-demo-header': 'dropped',
      },
    });

    const seen = response.json<{ method: string; path: string; headers: Record<string, string> }>();

    expect(seen.method).toBe('GET');
    expect(seen.path).toBe('/repos/acme/payments/issues/423');
    expect(seen.headers['accept']).toBe('application/vnd.github+json');
    expect(seen.headers['x-github-api-version']).toBe('2022-11-28');
    expect(seen.headers['x-demo-header']).toBeUndefined();
    // The credential the agent never held, added on the way out.
    expect(seen.headers['authorization']).toBeDefined();
  });

  it('throws from json() when the upstream answered with something else', async () => {
    echo = await startEchoUpstream();
    harness = await startHarness({ upstreamBaseUrl: echo.baseUrl });

    const response = await harness.gate.request({
      credential: harness.alias,
      method: 'GET',
      url: 'https://api.github.com/repos/acme/payments/pulls',
    });

    expect(response.body).toBe('not json at all');
    expect(() => response.json()).toThrow(MalformedResponseError);
  });

  it('says so when the gateway cannot be reached at all', async () => {
    // A port nothing is listening on: the agent's only route out is down, which is worth a
    // sentence rather than a bare `fetch failed`.
    const gate = new AgentGate({ gatewayUrl: 'http://127.0.0.1:1', token: 'irrelevant' });

    await expect(
      gate.request({ credential: 'github_work', method: 'GET', url: ISSUE_URL }),
    ).rejects.toBeInstanceOf(TransportError);
  });

  it('does not carry the mission token on any enumerable property', () => {
    // This class is instantiated inside the sandbox, next to whatever else the agent runs. A
    // token on a public field is one `JSON.stringify(client)` — in a log line, in an error
    // report, in a crash dump — away from being written down somewhere nobody is scrubbing.
    const token = 'mission-token-that-must-not-be-printed';
    const gate = new AgentGate({ gatewayUrl: 'http://gateway:8080', token });

    expect(JSON.stringify(gate)).not.toContain(token);
    expect(JSON.stringify({ client: gate })).not.toContain(token);
    expect(Object.keys(gate)).toHaveLength(0);
    expect(inspect(gate, { depth: 5 })).not.toContain(token);
  });

  it('refuses to be built without a gateway url or a token', () => {
    expect(() => new AgentGate({ gatewayUrl: '', token: 'x' })).toThrow(AgentGateSdkError);
    expect(() => new AgentGate({ gatewayUrl: 'http://gateway', token: '' })).toThrow(
      AgentGateSdkError,
    );
  });
});
