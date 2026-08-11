import { expect, test } from 'vitest';
import { AgentGateError } from '../src/errors.js';

test('a denied decision serialises to the machine-readable body from the spec', () => {
  const error = new AgentGateError(
    'agentgate_access_denied',
    403,
    'Repository is outside the mission scope.',
    { decision: 'DENY', matchedPolicy: 'mission.resources' },
  );

  expect(error.toBody('req_123')).toEqual({
    error: 'agentgate_access_denied',
    decision: 'DENY',
    reason: 'Repository is outside the mission scope.',
    request_id: 'req_123',
  });
});

test('the body omits decision when the error carries none', () => {
  const error = new AgentGateError('agentgate_not_found', 404, 'Mission mis_nope does not exist.');

  const body = error.toBody('req_456');

  expect(body).toEqual({
    error: 'agentgate_not_found',
    reason: 'Mission mis_nope does not exist.',
    request_id: 'req_456',
  });
  expect('decision' in body).toBe(false);
});

test('a details bag without a decision key stays out of the body', () => {
  const error = new AgentGateError('agentgate_limit_exceeded', 429, 'Request budget exhausted.', {
    maxRequests: 500,
  });

  expect(error.toBody('req_789')).toEqual({
    error: 'agentgate_limit_exceeded',
    reason: 'Request budget exhausted.',
    request_id: 'req_789',
  });
});

test('an unrecognised decision value in details is not propagated', () => {
  const error = new AgentGateError('agentgate_upstream_error', 502, 'Upstream refused.', {
    decision: 'MAYBE',
  });

  expect(error.toBody('req_abc')).not.toHaveProperty('decision');
});

test('it stays a throwable Error carrying its http status', () => {
  const error = new AgentGateError('agentgate_invalid_token', 401, 'Token rejected.');

  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe('AgentGateError');
  expect(error.httpStatus).toBe(401);
  expect(() => {
    throw error;
  }).toThrow('Token rejected.');
});
