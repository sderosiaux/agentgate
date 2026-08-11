import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentGate,
  MalformedResponseError,
  TimeoutError,
  TransportError,
  type ProxyRequest,
} from '../src/index.js';
import { startRawServer, startSilentServer, type RawServer } from './helpers/raw-server.js';

const READ: ProxyRequest = {
  credential: 'github_work',
  method: 'GET',
  url: 'https://api.github.com/repos/acme/payments/issues/423',
};

describe('when the gateway does not answer', () => {
  let server: RawServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('gives up after the configured timeout instead of waiting forever', async () => {
    server = await startSilentServer();
    const gate = new AgentGate({ gatewayUrl: server.baseUrl, token: 'irrelevant', timeoutMs: 200 });

    const failure = await gate.request(READ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TimeoutError);
    // A timeout is a transport failure, so an agent that only cares about "did I get an answer"
    // has one type to catch.
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TimeoutError).code).toBe('agentgate_sdk_timeout');
    expect((failure as TimeoutError).message).toContain('200');
  });

  it('honours a signal the caller brought', async () => {
    server = await startSilentServer();
    const gate = new AgentGate({ gatewayUrl: server.baseUrl, token: 'irrelevant' });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const failure = await gate
      .request({ ...READ, signal: controller.signal })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TransportError);
    // Not a timeout: the caller stopped this, and an agent retrying on timeouts must not treat
    // its own cancellation as one.
    expect(failure).not.toBeInstanceOf(TimeoutError);
  });

  it('reports an unreachable gateway as a transport failure', async () => {
    const gate = new AgentGate({ gatewayUrl: 'http://127.0.0.1:1', token: 'irrelevant' });

    await expect(gate.request(READ)).rejects.toBeInstanceOf(TransportError);
  });

  it('applies the timeout to an approval poll too', async () => {
    server = await startSilentServer();
    const gate = new AgentGate({ gatewayUrl: server.baseUrl, token: 'irrelevant', timeoutMs: 200 });

    await expect(gate.getApproval('apr_x')).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe('when the gateway answers with something unreadable', () => {
  let server: RawServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('refuses an approval status it does not know rather than reading it as pending', async () => {
    server = await startRawServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'apr_x',
          // Neither approved nor pending: a status this SDK cannot act on, which silently
          // became "keep waiting" until the poll timed out two minutes later.
          status: 'escalated',
          resource: 'github:acme/payments',
          action: 'pull_request.create',
          requestedAt: new Date().toISOString(),
        }),
      );
    });
    const gate = new AgentGate({ gatewayUrl: server.baseUrl, token: 'irrelevant' });

    const failure = await gate.getApproval('apr_x').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MalformedResponseError);
    expect((failure as MalformedResponseError).message).toContain('escalated');
  });

  it('reports a non-json approval answer the same way it reports a non-json body', async () => {
    server = await startRawServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('not json at all');
    });
    const gate = new AgentGate({ gatewayUrl: server.baseUrl, token: 'irrelevant' });

    await expect(gate.getApproval('apr_x')).rejects.toBeInstanceOf(MalformedResponseError);
  });
});
