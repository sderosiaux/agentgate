import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AgentGateError } from '@agentgate/shared';
import { afterEach, describe, expect, test } from 'vitest';
import { createBuiltinEngine } from '../src/engine.js';
import { createOpaEngine } from '../src/opa.js';
import type { PolicyInput } from '../src/types.js';
import { DECISION_MATRIX, MALFORMED_INPUTS, SAMPLE_CASE, inputFor } from './matrix.js';

const running: Server[] = [];

/** A stand-in OPA, so the client's failure modes are covered without a container. */
async function serving(
  handler: (body: unknown) => { status?: number; payload: string },
): Promise<string> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const { status = 200, payload } = handler(JSON.parse(raw));
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(payload);
    });
  });
  running.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await Promise.all(
    running
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe('createOpaEngine', () => {
  test('posts the input under an "input" key and returns the decision', async () => {
    let seen: unknown;
    const url = await serving((body) => {
      seen = body;
      return {
        payload: JSON.stringify({
          result: { decision: 'ALLOW', reason: 'because', matchedPolicy: 'mission-allowed-action' },
        }),
      };
    });
    const policyInput = inputFor(SAMPLE_CASE);

    await expect(createOpaEngine(url).evaluate(policyInput)).resolves.toEqual({
      decision: 'ALLOW',
      reason: 'because',
      matchedPolicy: 'mission-allowed-action',
    });
    expect(seen).toEqual({ input: JSON.parse(JSON.stringify(policyInput)) });
  });

  test('tolerates a trailing slash on the base url', async () => {
    let path: string | undefined;
    const server = createServer((request, response) => {
      path = request.url;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ result: { decision: 'DENY', reason: 'no' } }));
    });
    running.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

    await expect(createOpaEngine(url).evaluate(inputFor(SAMPLE_CASE))).resolves.toEqual({
      decision: 'DENY',
      reason: 'no',
    });
    expect(path).toBe('/v1/data/agentgate/decision');
  });

  test('an undefined policy result is an error, never a silent allow', async () => {
    const url = await serving(() => ({ payload: JSON.stringify({}) }));
    await expect(createOpaEngine(url).evaluate(inputFor(SAMPLE_CASE))).rejects.toThrowError(
      AgentGateError,
    );
  });

  test('an unknown decision word is rejected', async () => {
    const url = await serving(() => ({
      payload: JSON.stringify({ result: { decision: 'MAYBE', reason: 'hmm' } }),
    }));
    await expect(createOpaEngine(url).evaluate(inputFor(SAMPLE_CASE))).rejects.toThrowError(
      AgentGateError,
    );
  });

  test('a server error is surfaced as an upstream failure', async () => {
    const url = await serving(() => ({ status: 500, payload: '{"code":"internal_error"}' }));
    const error = await createOpaEngine(url)
      .evaluate(inputFor(SAMPLE_CASE))
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AgentGateError);
    expect((error as AgentGateError).code).toBe('agentgate_upstream_error');
    expect((error as AgentGateError).httpStatus).toBe(502);
  });

  test('a body that is not json is an error', async () => {
    const url = await serving(() => ({ payload: 'not json at all' }));
    await expect(createOpaEngine(url).evaluate(inputFor(SAMPLE_CASE))).rejects.toThrowError(
      AgentGateError,
    );
  });

  test.each(MALFORMED_INPUTS)('refuses $name without calling out', async ({ input }) => {
    let called = false;
    const url = await serving(() => {
      called = true;
      return {
        payload: JSON.stringify({ result: { decision: 'ALLOW', reason: 'should never be asked' } }),
      };
    });

    await expect(createOpaEngine(url).evaluate(input as PolicyInput)).rejects.toThrowError(
      AgentGateError,
    );
    expect(called, 'a malformed input must not reach the policy engine').toBe(false);
  });

  test('an unreachable engine is an error', async () => {
    // Port 1 on loopback: nothing listens there, the connection is refused immediately.
    await expect(
      createOpaEngine('http://127.0.0.1:1').evaluate(inputFor(SAMPLE_CASE)),
    ).rejects.toThrowError(AgentGateError);
  });
});

/**
 * The real parity gate: the same matrix that pins the builtin engine, replayed against a live
 * OPA. Run it with `OPA_URL=http://127.0.0.1:8181 pnpm --filter @agentgate/policy test`.
 */
describe.skipIf(!process.env['OPA_URL'])('opa parity', () => {
  const opaUrl = process.env['OPA_URL'] ?? '';
  const opa = createOpaEngine(opaUrl);
  const builtin = createBuiltinEngine();

  /** Straight to the rego, past the client's own validation, to see what the policy alone says. */
  async function askRego(input: unknown): Promise<{ decision?: string } | undefined> {
    const response = await fetch(`${opaUrl.replace(/\/+$/, '')}/v1/data/agentgate/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input }),
    });
    const body = (await response.json()) as { result?: { decision?: string } };
    return body.result;
  }

  test.each(DECISION_MATRIX)('$name', async (decisionCase) => {
    const policyInput = inputFor(decisionCase);

    await expect(opa.evaluate(policyInput)).resolves.toEqual(decisionCase.expected);
    await expect(opa.evaluate(policyInput)).resolves.toEqual(await builtin.evaluate(policyInput));
  });

  test.each(MALFORMED_INPUTS)('both engines refuse $name', async ({ input }) => {
    await expect(builtin.evaluate(input as PolicyInput)).rejects.toThrowError(AgentGateError);
    await expect(opa.evaluate(input as PolicyInput)).rejects.toThrowError(AgentGateError);

    // And if one ever slipped past the client, the policy itself still must not allow it.
    expect(await askRego(input)).toMatchObject({ decision: 'DENY' });
  });
});
