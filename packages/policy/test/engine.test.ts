import { describe, expect, test } from 'vitest';
import { createBuiltinEngine } from '../src/engine.js';
import { DECISION_MATRIX, inputFor } from './matrix.js';

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

  test('network rules are the pipeline’s business, not the engine’s', async () => {
    const input = inputFor({
      name: 'allowed action behind a deny-everything network rule',
      permissions: {
        resources: ['github:acme/payments'],
        allowedActions: ['repo.read'],
        approvalActions: [],
        deniedActions: [],
      },
      resource: { provider: 'github', id: 'acme/payments' },
      action: { type: 'repo.read', method: 'GET' },
      expected: { decision: 'ALLOW', reason: '', matchedPolicy: '' },
    });
    input.mission.network = { allow: [], deny: [{ host: '*' }] };

    // D3 steps 4 and 5 run before the engine is ever called; it must not second-guess them.
    await expect(engine.evaluate(input)).resolves.toMatchObject({ decision: 'ALLOW' });
  });

  test('an expired mission is still not the engine’s call', async () => {
    const [first] = DECISION_MATRIX;
    if (first === undefined) throw new Error('empty matrix');
    const input = inputFor(first);
    input.mission.expiresAt = '2000-01-01T00:00:00.000Z';

    await expect(engine.evaluate(input)).resolves.toEqual(first.expected);
  });

  test('the same input twice gives the same decision', async () => {
    const [first] = DECISION_MATRIX;
    if (first === undefined) throw new Error('empty matrix');
    const input = inputFor(first);

    await expect(engine.evaluate(input)).resolves.toEqual(await engine.evaluate(input));
  });

  test('evaluating does not mutate the input', async () => {
    const [first] = DECISION_MATRIX;
    if (first === undefined) throw new Error('empty matrix');
    const input = inputFor(first);
    const before = structuredClone(input);

    await engine.evaluate(input);

    expect(input).toEqual(before);
  });
});
