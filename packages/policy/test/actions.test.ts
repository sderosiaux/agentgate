import { describe, expect, test } from 'vitest';
import { actionImplied } from '../src/actions.js';

describe('actionImplied', () => {
  test('an action always covers itself', () => {
    for (const action of [
      'repo.read',
      'issue.read',
      'pull_request.read',
      'pull_request.create',
      'pull_request.merge',
      'branch.create',
      'repository.delete',
    ]) {
      expect(actionImplied(action, action)).toBe(true);
    }
  });

  test('repo.read covers issue.read and pull_request.read', () => {
    expect(actionImplied('repo.read', 'issue.read')).toBe(true);
    expect(actionImplied('repo.read', 'pull_request.read')).toBe(true);
  });

  test('the implication is one-way', () => {
    expect(actionImplied('issue.read', 'repo.read')).toBe(false);
    expect(actionImplied('pull_request.read', 'repo.read')).toBe(false);
    expect(actionImplied('issue.read', 'pull_request.read')).toBe(false);
  });

  test('reads never cover writes', () => {
    for (const write of [
      'pull_request.create',
      'pull_request.merge',
      'branch.create',
      'repository.delete',
    ]) {
      expect(actionImplied('repo.read', write)).toBe(false);
    }
  });

  test('there is no wildcard and no prefix magic', () => {
    expect(actionImplied('*', 'repo.read')).toBe(false);
    expect(actionImplied('repo', 'repo.read')).toBe(false);
    expect(actionImplied('repo.*', 'repo.read')).toBe(false);
    expect(actionImplied('repo.read', 'repo.read.extra')).toBe(false);
  });

  test('unknown actions fall back to strict equality', () => {
    expect(actionImplied('made.up', 'made.up')).toBe(true);
    expect(actionImplied('made.up', 'issue.read')).toBe(false);
    expect(actionImplied('', '')).toBe(true);
  });
});
