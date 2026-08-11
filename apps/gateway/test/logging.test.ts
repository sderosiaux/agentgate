import { expect, test } from 'vitest';
import { createLogger, registerSensitive, scrubSensitive } from '../src/logging.js';

/** Collects the raw lines a logger writes, exactly as they would reach stdout. */
function captureLogger() {
  const lines: string[] = [];
  const logger = createLogger({
    level: 'trace',
    destination: {
      write(line: string) {
        lines.push(line);
      },
    },
  });

  return { logger, lines, output: () => lines.join('') };
}

test('a registered value is scrubbed out of the message', () => {
  registerSensitive('scrub-me-token-alpha');

  expect(scrubSensitive('the token is scrub-me-token-alpha, keep it')).toBe(
    'the token is [REDACTED], keep it',
  );
});

test('a value too short to be a credential is not registered', () => {
  registerSensitive('abc');

  expect(scrubSensitive('abc')).toBe('abc');
});

test('a registered value is scrubbed everywhere in a log line, not only in known keys', () => {
  const secret = 'scrub-me-token-bravo';
  registerSensitive(secret);
  const { logger, output } = captureLogger();

  logger.info({ upstream: { note: secret }, deep: [{ nested: secret }] }, `msg carrying ${secret}`);

  expect(output()).not.toContain(secret);
  expect(output()).toContain('[REDACTED]');
});

test('a registered value is scrubbed out of an error message and its stack', () => {
  const secret = 'scrub-me-token-charlie';
  registerSensitive(secret);
  const { logger, output } = captureLogger();

  logger.error({ err: new Error(`upstream refused ${secret}`) }, 'request failed');

  expect(output()).not.toContain(secret);
});

test('a registered value is scrubbed even when json escaping rewrites it', () => {
  // A secret carrying a quote or a backslash is not a substring of the serialised line:
  // the escaped spelling is what actually lands in the output.
  const secret = 'quote"and\\backslash-token';
  registerSensitive(secret);
  const { logger, output } = captureLogger();

  logger.info({ header: secret }, 'built the injected header');

  expect(output()).not.toContain('quote');
  expect(output()).not.toContain('backslash-token');
});

test('an authorization header is redacted by path, registered or not', () => {
  const { logger, output } = captureLogger();

  logger.info({ req: { headers: { authorization: 'Bearer never-registered-jwt' } } }, 'incoming');
  logger.info({ upstream: { headers: { authorization: 'token never-registered-2' } } }, 'outgoing');

  expect(output()).not.toContain('never-registered-jwt');
  expect(output()).not.toContain('never-registered-2');
});

test('keys that carry credential material by convention are redacted by path', () => {
  const { logger, output } = captureLogger();

  logger.info(
    { credential: { value: 'v-never-registered', token: 't-never-registered' } },
    'resolved',
  );

  expect(output()).not.toContain('v-never-registered');
  expect(output()).not.toContain('t-never-registered');
});

test('log lines stay valid json after scrubbing', () => {
  const secret = 'scrub-me-token-delta';
  registerSensitive(secret);
  const { logger, lines } = captureLogger();

  logger.info({ alias: 'github_work', leaked: secret }, 'forwarded');

  const parsed = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
  expect(parsed['alias']).toBe('github_work');
  expect(parsed['leaked']).toBe('[REDACTED]');
  expect(parsed['msg']).toBe('forwarded');
});
