import { AgentGateError } from '@agentgate/shared';
import { describe, expect, test } from 'vitest';
import { createBuiltinEngine } from '../src/engine.js';
import type { PolicyInput } from '../src/types.js';
import { DECISION_MATRIX, MALFORMED_INPUTS, SAMPLE_CASE, inputFor } from './matrix.js';

const engine = createBuiltinEngine();

describe('createBuiltinEngine', () => {
  test.each(DECISION_MATRIX)('$name', async (decisionCase) => {
    await expect(engine.evaluate(inputFor(decisionCase))).resolves.toEqual(decisionCase.expected);
  });

  test('the matrix covers every matched policy the engine can return', () => {
    expect(new Set(DECISION_MATRIX.map((c) => c.expected.matchedPolicy))).toEqual(
      new Set([
        'mission-resource-scope',
        'mission-denied-action',
        'mission-approval-required',
        'mission-allowed-action',
        'mission-default-deny',
      ]),
    );
  });

  test.each(MALFORMED_INPUTS)('refuses to decide when $name', async ({ input }) => {
    const error = await engine.evaluate(input as PolicyInput).then(
      (decision) => new Error(`expected a refusal, got ${JSON.stringify(decision)}`),
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(AgentGateError);
    expect((error as AgentGateError).code).toBe('agentgate_validation_error');
  });

  test('a mission listing an object member as an action still decides', async () => {
    const input = inputFor(SAMPLE_CASE);
    input.mission.permissions = {
      resources: ['github:acme/payments'],
      allowedActions: ['repo.read'],
      approvalActions: [],
      deniedActions: ['toString', '__proto__', 'constructor'],
    };

    await expect(engine.evaluate(input)).resolves.toEqual(SAMPLE_CASE.expected);
  });

  test('network rules are the pipeline’s business, not the engine’s', async () => {
    const input = inputFor(SAMPLE_CASE);
    input.mission.network = { allow: [], deny: [{ host: '*' }] };

    // D3 steps 4 and 5 run before the engine is ever called; it must not second-guess them.
    await expect(engine.evaluate(input)).resolves.toMatchObject({ decision: 'ALLOW' });
  });

  test('an expired mission is still not the engine’s call', async () => {
    const input = inputFor(SAMPLE_CASE);
    input.mission.expiresAt = '2000-01-01T00:00:00.000Z';

    await expect(engine.evaluate(input)).resolves.toEqual(SAMPLE_CASE.expected);
  });

  test('the same input twice gives the same decision', async () => {
    const input = inputFor(SAMPLE_CASE);

    await expect(engine.evaluate(input)).resolves.toEqual(await engine.evaluate(input));
  });

  test('evaluating does not mutate the input', async () => {
    const input = inputFor(SAMPLE_CASE);
    const before = structuredClone(input);

    await engine.evaluate(input);

    expect(input).toEqual(before);
  });
});
