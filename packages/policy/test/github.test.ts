import { AgentGateError } from '@agentgate/shared';
import { describe, expect, test } from 'vitest';
import { githubAdapter } from '../src/adapters/github.js';

/** The D4 table, verbatim. Every row is asserted in both directions. */
const D4_TABLE = [
  { method: 'GET', path: '/repos/acme/payments', action: 'repo.read' },
  { method: 'GET', path: '/repos/acme/payments/issues/42', action: 'issue.read' },
  { method: 'GET', path: '/repos/acme/payments/pulls', action: 'pull_request.read' },
  { method: 'POST', path: '/repos/acme/payments/pulls', action: 'pull_request.create' },
  { method: 'POST', path: '/repos/acme/payments/git/refs', action: 'branch.create' },
  { method: 'PUT', path: '/repos/acme/payments/pulls/7/merge', action: 'pull_request.merge' },
  { method: 'DELETE', path: '/repos/acme/payments', action: 'repository.delete' },
] as const;

describe('githubAdapter', () => {
  test('claims the github api host and nothing else', () => {
    expect(githubAdapter.provider).toBe('github');
    expect(githubAdapter.matchesHost('api.github.com')).toBe(true);
    expect(githubAdapter.matchesHost('API.GitHub.com')).toBe(true);
    expect(githubAdapter.matchesHost('github.com')).toBe(false);
    expect(githubAdapter.matchesHost('api.github.com.evil.test')).toBe(false);
    expect(githubAdapter.matchesHost('gitlab.com')).toBe(false);
  });

  test.each(D4_TABLE)('$method $path maps to $action', ({ method, path, action }) => {
    expect(githubAdapter.mapRequest(method, path)).toEqual({
      resource: 'github:acme/payments',
      action,
    });
  });

  test.each(D4_TABLE)('$method $path maps to no other action', ({ method, path, action }) => {
    const others = D4_TABLE.filter((row) => row.action !== action).map((row) => row.action);
    expect(others).not.toContain(githubAdapter.mapRequest(method, path)?.action);
  });

  test('the owner and repo travel into the resource id', () => {
    expect(githubAdapter.mapRequest('GET', '/repos/other-org/some.repo_1')).toEqual({
      resource: 'github:other-org/some.repo_1',
      action: 'repo.read',
    });
  });

  test('the method is matched case-insensitively', () => {
    expect(githubAdapter.mapRequest('get', '/repos/acme/payments')?.action).toBe('repo.read');
  });

  test('a right path with a wrong method is unmapped', () => {
    expect(githubAdapter.mapRequest('DELETE', '/repos/acme/payments/pulls')).toBeNull();
    expect(githubAdapter.mapRequest('POST', '/repos/acme/payments')).toBeNull();
    expect(githubAdapter.mapRequest('PATCH', '/repos/acme/payments/pulls/7/merge')).toBeNull();
    expect(githubAdapter.mapRequest('GET', '/repos/acme/payments/git/refs')).toBeNull();
  });

  test('unknown routes are unmapped rather than guessed', () => {
    for (const path of [
      '/',
      '/user',
      '/repos',
      '/repos/acme',
      '/repos/acme/payments/branches',
      '/repos/acme/payments/issues',
      '/repos/acme/payments/issues/42/comments',
      '/repos/acme/payments/pulls/7',
      '/repos/acme/payments/pulls/7/files',
      '/repos/acme/payments/git/refs/heads/main',
      '/orgs/acme/repos',
    ]) {
      expect(githubAdapter.mapRequest('GET', path), path).toBeNull();
      expect(githubAdapter.mapRequest('POST', path), path).toBeNull();
    }
  });

  test('a non-numeric issue or pull number is unmapped', () => {
    expect(githubAdapter.mapRequest('GET', '/repos/acme/payments/issues/latest')).toBeNull();
    expect(githubAdapter.mapRequest('PUT', '/repos/acme/payments/pulls/all/merge')).toBeNull();
  });

  test('an owner or repo that is not a plain name is unmapped', () => {
    expect(githubAdapter.mapRequest('GET', '/repos/ac me/payments')).toBeNull();
    expect(githubAdapter.mapRequest('GET', '/repos/acme/pay:ments')).toBeNull();
  });

  test('an unnormalized path is a programming error, not a routing decision', () => {
    for (const path of ['/repos/acme/oops/../payments', '/repos/acme/payments/..', '/repos/../x']) {
      expect(() => githubAdapter.mapRequest('GET', path), path).toThrowError(AgentGateError);
    }
  });

  test('a relative path is refused outright', () => {
    expect(() => githubAdapter.mapRequest('GET', 'repos/acme/payments')).toThrowError(
      AgentGateError,
    );
  });
});
