import { AgentGateError } from '@agentgate/shared';
import { describe, expect, test } from 'vitest';
import type { z } from 'zod';
import { PolicyInputSchema, parsePolicyInput, type PolicyInput } from '../src/types.js';
import { SAMPLE_CASE, inputFor } from './matrix.js';

type Inferred = z.infer<typeof PolicyInputSchema>;

/**
 * A compile-time guard, not a runtime one: if the schema and the hand-written interface ever
 * disagree about a field, this stops typechecking. The interface is what callers read, the
 * schema is what actually guards the engines, and a gap between them is a gap in the guard.
 */
const _schemaMatchesInterface: [
  Inferred extends PolicyInput ? true : false,
  PolicyInput extends Inferred ? true : false,
] = [true, true];

describe('parsePolicyInput', () => {
  test('returns a well-formed input unchanged', () => {
    const input = inputFor(SAMPLE_CASE);

    expect(parsePolicyInput(input)).toEqual(input);
  });

  test('keeps the optional data fields when they are there', () => {
    const input = inputFor(SAMPLE_CASE);
    input.data = { contentType: 'application/json', bodySize: 12, bodyHash: 'abc' };

    expect(parsePolicyInput(input).data).toEqual(input.data);
  });

  test('refuses an input with a validation error, never a decision', () => {
    const input = { ...inputFor(SAMPLE_CASE), resource: { provider: '', id: 'acme/payments' } };

    expect(() => parsePolicyInput(input)).toThrowError(AgentGateError);
    try {
      parsePolicyInput(input);
    } catch (error) {
      expect((error as AgentGateError).code).toBe('agentgate_validation_error');
      expect((error as AgentGateError).httpStatus).toBe(400);
      // The zod failure is kept for the logs and kept out of the response body.
      expect((error as AgentGateError).cause).toBeDefined();
      expect((error as AgentGateError).toBody('req_1')).toEqual({
        error: 'agentgate_validation_error',
        reason: 'policy input is not well formed',
        request_id: 'req_1',
      });
    }
  });

  test('an unknown key in the mission permissions is refused', () => {
    const input = inputFor(SAMPLE_CASE);
    (input.mission.permissions as unknown as Record<string, unknown>)['wildcards'] = ['*'];

    expect(() => parsePolicyInput(input)).toThrowError(AgentGateError);
  });
});
