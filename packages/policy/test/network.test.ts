import type { NetworkRules } from '@agentgate/shared';
import { describe, expect, test } from 'vitest';
import { matchNetworkRules } from '../src/network.js';

const EMPTY: NetworkRules = { allow: [], deny: [] };

function match(rules: NetworkRules, host: string, path: string, method = 'GET'): string {
  return matchNetworkRules(rules, { host, path, method }).matched;
}

describe('matchNetworkRules', () => {
  test('empty rules match nothing', () => {
    expect(match(EMPTY, 'api.github.com', '/repos/acme/payments')).toBe('none');
  });

  test('a host with no path clause matches every path', () => {
    const rules: NetworkRules = { ...EMPTY, allow: [{ host: 'api.github.com' }] };
    expect(match(rules, 'api.github.com', '/')).toBe('allow');
    expect(match(rules, 'api.github.com', '/repos/acme/payments/pulls/1/merge')).toBe('allow');
  });

  test('a host is matched exactly', () => {
    const rules: NetworkRules = { ...EMPTY, allow: [{ host: 'api.github.com' }] };
    expect(match(rules, 'api.github.com', '/x')).toBe('allow');
    expect(match(rules, 'evil-api.github.com', '/x')).toBe('none');
    expect(match(rules, 'api.github.com.evil.test', '/x')).toBe('none');
  });

  test('a host is compared case-insensitively', () => {
    const rules: NetworkRules = { ...EMPTY, allow: [{ host: 'API.GitHub.com' }] };
    expect(match(rules, 'api.github.com', '/x')).toBe('allow');
  });

  test('the "*" host matches anything', () => {
    const rules: NetworkRules = { ...EMPTY, deny: [{ host: '*' }] };
    expect(match(rules, 'anything.test', '/x')).toBe('deny');
  });

  test('"*.github.com" matches a subdomain but not the apex', () => {
    const rules: NetworkRules = { ...EMPTY, allow: [{ host: '*.github.com' }] };
    expect(match(rules, 'api.github.com', '/x')).toBe('allow');
    expect(match(rules, 'uploads.api.github.com', '/x')).toBe('allow');
    expect(match(rules, 'github.com', '/x')).toBe('none');
    expect(match(rules, 'notgithub.com', '/x')).toBe('none');
    expect(match(rules, 'api.github.com.evil.test', '/x')).toBe('none');
  });

  test('a literal path is matched exactly', () => {
    const rules: NetworkRules = {
      ...EMPTY,
      allow: [{ host: 'api.github.com', path: '/repos/acme/payments' }],
    };
    expect(match(rules, 'api.github.com', '/repos/acme/payments')).toBe('allow');
    expect(match(rules, 'api.github.com', '/repos/acme/payments/pulls')).toBe('none');
    expect(match(rules, 'api.github.com', '/repos/acme')).toBe('none');
  });

  test('"*" matches one segment and never crosses a slash', () => {
    const rules: NetworkRules = {
      ...EMPTY,
      allow: [{ host: 'api.github.com', path: '/repos/*/payments' }],
    };
    expect(match(rules, 'api.github.com', '/repos/acme/payments')).toBe('allow');
    expect(match(rules, 'api.github.com', '/repos/other/payments')).toBe('allow');
    expect(match(rules, 'api.github.com', '/repos/acme/sub/payments')).toBe('none');
    expect(match(rules, 'api.github.com', '/repos/payments')).toBe('none');
  });

  test('"*" inside a segment is not a partial wildcard', () => {
    const rules: NetworkRules = {
      ...EMPTY,
      allow: [{ host: 'api.github.com', path: '/repos/acme*' }],
    };
    expect(match(rules, 'api.github.com', '/repos/acmex')).toBe('none');
    expect(match(rules, 'api.github.com', '/repos/acme*')).toBe('allow');
  });

  test('"**" matches any depth, including the prefix itself', () => {
    const rules: NetworkRules = {
      ...EMPTY,
      allow: [{ host: 'api.github.com', path: '/repos/acme/payments/**' }],
    };
    expect(match(rules, 'api.github.com', '/repos/acme/payments')).toBe('allow');
    expect(match(rules, 'api.github.com', '/repos/acme/payments/pulls')).toBe('allow');
    expect(match(rules, 'api.github.com', '/repos/acme/payments/pulls/1/merge')).toBe('allow');
  });

  test('"**" does not match a sibling with a longer name', () => {
    const rules: NetworkRules = {
      ...EMPTY,
      allow: [{ host: 'api.github.com', path: '/repos/acme/payments/**' }],
    };
    expect(match(rules, 'api.github.com', '/repos/acme/payments2/x')).toBe('none');
    expect(match(rules, 'api.github.com', '/repos/acme')).toBe('none');
  });

  test('"**" can sit in the middle of a pattern', () => {
    const rules: NetworkRules = {
      ...EMPTY,
      allow: [{ host: 'api.github.com', path: '/repos/**/merge' }],
    };
    expect(match(rules, 'api.github.com', '/repos/acme/payments/pulls/1/merge')).toBe('allow');
    expect(match(rules, 'api.github.com', '/repos/merge')).toBe('allow');
    expect(match(rules, 'api.github.com', '/repos/acme/payments')).toBe('none');
  });

  test('the methods clause filters, and its absence means every method', () => {
    const filtered: NetworkRules = {
      ...EMPTY,
      allow: [{ host: 'api.github.com', methods: ['GET', 'POST'] }],
    };
    expect(match(filtered, 'api.github.com', '/x', 'GET')).toBe('allow');
    expect(match(filtered, 'api.github.com', '/x', 'POST')).toBe('allow');
    expect(match(filtered, 'api.github.com', '/x', 'DELETE')).toBe('none');

    const unfiltered: NetworkRules = { ...EMPTY, allow: [{ host: 'api.github.com' }] };
    expect(match(unfiltered, 'api.github.com', '/x', 'DELETE')).toBe('allow');
  });

  test('the method is compared case-insensitively', () => {
    const rules: NetworkRules = {
      ...EMPTY,
      allow: [{ host: 'api.github.com', methods: ['DELETE'] }],
    };
    expect(match(rules, 'api.github.com', '/x', 'delete')).toBe('allow');
  });

  test('an empty methods list matches no method at all', () => {
    const rules: NetworkRules = { ...EMPTY, allow: [{ host: 'api.github.com', methods: [] }] };
    expect(match(rules, 'api.github.com', '/x', 'GET')).toBe('none');
  });

  test('deny wins over an allow covering the same request', () => {
    const rules: NetworkRules = {
      allow: [{ host: '*.github.com' }],
      deny: [{ host: 'api.github.com', path: '/repos/acme/payments/**', methods: ['DELETE'] }],
    };
    expect(match(rules, 'api.github.com', '/repos/acme/payments', 'DELETE')).toBe('deny');
    expect(match(rules, 'api.github.com', '/repos/acme/payments', 'GET')).toBe('allow');
  });

  test('any matching rule in a list is enough', () => {
    const rules: NetworkRules = {
      ...EMPTY,
      allow: [{ host: 'other.test' }, { host: 'api.github.com', path: '/repos/**' }],
    };
    expect(match(rules, 'api.github.com', '/repos/acme')).toBe('allow');
  });
});
