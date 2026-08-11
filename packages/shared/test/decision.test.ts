import { expect, test } from 'vitest';
import { DECISIONS, isDecision } from '../src/decision.js';

test('the three decisions of the spec are the only ones recognised', () => {
  expect(DECISIONS).toEqual(['ALLOW', 'DENY', 'REQUIRE_APPROVAL']);

  for (const decision of DECISIONS) {
    expect(isDecision(decision)).toBe(true);
  }
});

test('anything else is not a decision', () => {
  for (const value of ['allow', 'MAYBE', '', 0, null, undefined, {}]) {
    expect(isDecision(value)).toBe(false);
  }
});
