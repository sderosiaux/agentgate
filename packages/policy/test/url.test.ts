import { AgentGateError } from '@agentgate/shared';
import { describe, expect, test } from 'vitest';
import { normalizeUrl } from '../src/url.js';

function expectRejected(raw: string): AgentGateError {
  let thrown: unknown;
  try {
    normalizeUrl(raw);
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `expected ${raw} to be rejected`).toBeInstanceOf(AgentGateError);
  const error = thrown as AgentGateError;
  expect(error.code).toBe('agentgate_validation_error');
  expect(error.httpStatus).toBe(400);
  return error;
}

describe('normalizeUrl', () => {
  test('splits a plain url into host, path and protocol', () => {
    expect(normalizeUrl('https://api.github.com/repos/acme/payments')).toEqual({
      host: 'api.github.com',
      path: '/repos/acme/payments',
      protocol: 'https:',
    });
  });

  test('keeps http as well as https', () => {
    expect(normalizeUrl('http://api.github.com/repos/acme/payments').protocol).toBe('http:');
  });

  test('lowercases the host', () => {
    expect(normalizeUrl('https://API.GitHub.COM/repos/acme/payments').host).toBe('api.github.com');
  });

  test('drops the port, which no matching rule speaks about', () => {
    expect(normalizeUrl('https://api.github.com:8443/repos/acme/payments').host).toBe(
      'api.github.com',
    );
  });

  test('strips the query string and the fragment', () => {
    expect(normalizeUrl('https://api.github.com/repos/acme/payments?state=open#top').path).toBe(
      '/repos/acme/payments',
    );
  });

  test('collapses repeated slashes', () => {
    expect(normalizeUrl('https://api.github.com//repos///acme//payments').path).toBe(
      '/repos/acme/payments',
    );
  });

  test('collapses single-dot segments', () => {
    expect(normalizeUrl('https://api.github.com/repos/./acme/payments').path).toBe(
      '/repos/acme/payments',
    );
  });

  test('collapses a double-dot segment that stays inside the root', () => {
    expect(normalizeUrl('https://api.github.com/repos/acme/oops/../payments').path).toBe(
      '/repos/acme/payments',
    );
  });

  test('drops the trailing slash so both spellings match the same rules', () => {
    expect(normalizeUrl('https://api.github.com/repos/acme/payments/').path).toBe(
      '/repos/acme/payments',
    );
  });

  test('keeps the root path as a single slash', () => {
    expect(normalizeUrl('https://api.github.com').path).toBe('/');
    expect(normalizeUrl('https://api.github.com/').path).toBe('/');
  });

  test('rejects a path escaping the root', () => {
    expectRejected('https://api.github.com/repos/../../etc/passwd');
  });

  test('rejects a percent-encoded escape once it is decoded', () => {
    expectRejected('https://api.github.com/repos/%2e%2e/%2e%2e/etc/passwd');
  });

  test('decodes percent-encoding before matching', () => {
    expect(normalizeUrl('https://api.github.com/repos/acme/pay%6dents').path).toBe(
      '/repos/acme/payments',
    );
  });

  test('decodes only once, so a double-encoded escape stays inert', () => {
    expect(normalizeUrl('https://api.github.com/repos/%252e%252e/payments').path).toBe(
      '/repos/%2e%2e/payments',
    );
  });

  test('rejects malformed percent-encoding', () => {
    expectRejected('https://api.github.com/repos/%zz');
  });

  test('rejects userinfo in the authority', () => {
    expectRejected('https://user@api.github.com/repos/acme/payments');
    expectRejected('https://user:secret@api.github.com/repos/acme/payments');
    expectRejected('https://:secret@api.github.com/repos/acme/payments');
  });

  test('rejects a non-http scheme', () => {
    expectRejected('ftp://api.github.com/repos/acme/payments');
    expectRejected('file:///etc/passwd');
    expectRejected('javascript:alert(1)');
  });

  test('rejects control characters and whitespace, which url parsing would silently strip', () => {
    expectRejected('https://api.github.com/re\tpos/acme/payments');
    expectRejected('https://api.github.com/repos/acme/payments\n');
    expectRejected('https://api.github.com/repos/acme /payments');
  });

  test('rejects a backslash, which url parsing reads as a path separator', () => {
    // `new URL` resolves this to /evil/repos/acme/payments; reading the raw string naively
    // gives /repos/acme/payments, an allowed repo.read on a path the upstream never serves.
    expectRejected('https://api.github.com\\evil/repos/acme/payments');
    expect(new URL('https://api.github.com\\evil/repos/acme/payments').pathname).toBe(
      '/evil/repos/acme/payments',
    );
  });

  test('rejects a percent-encoded backslash once it is decoded', () => {
    expectRejected('https://api.github.com/repos%5c../acme/payments');
    expectRejected('https://api.github.com/repos%5C..%5Cacme');
  });

  test('rejects a backslash wherever it sits', () => {
    expectRejected('https://api.github.com/repos/acme\\payments');
    expectRejected('https://api.github.com/repos/acme/payments\\');
  });

  test('rejects a decoded path carrying control characters', () => {
    expectRejected('https://api.github.com/repos/acme/payments%00.json');
  });

  test('rejects a string that is not an absolute url at all', () => {
    expectRejected('/repos/acme/payments');
    expectRejected('api.github.com/repos');
    expectRejected('');
  });

  test('never leaks the raw url into the client-facing reason', () => {
    const error = expectRejected('https://user:hunter2@api.github.com/x');
    expect(error.message).not.toContain('hunter2');
  });
});
