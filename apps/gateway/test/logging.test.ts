import { expect, test } from 'vitest';
import {
  createExactScrubber,
  createLogger,
  MIN_SENSITIVE_LENGTH,
  registerSensitive,
  scrubSensitive,
} from '../src/logging.js';

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

test('an exact scrubber removes a value the global one is right to refuse', () => {
  // The length threshold is about reach, not about worth: given an exact value and a bounded
  // piece of text, there is nothing unrelated to damage.
  const short = 'zQ7';
  expect(short.length).toBeLessThan(MIN_SENSITIVE_LENGTH);

  expect(createExactScrubber([short])('reflected zQ7 back')).toBe('reflected [REDACTED] back');
  // ... and the global set is left exactly as it was.
  expect(scrubSensitive('reflected zQ7 back')).toBe('reflected zQ7 back');
});

test('an exact scrubber strikes the longest value first', () => {
  // `Bearer tok` contains `tok`. Shortest-first would leave `Bearer [REDACTED]`, which tells an
  // agent the scheme and the shape of what it was denied.
  const scrub = createExactScrubber(['tok', 'Bearer tok']);

  expect(scrub('sent Bearer tok upstream')).toBe('sent [REDACTED] upstream');
});

test('an exact scrubber matches the json-escaped spelling too', () => {
  const secret = 'qu"ote';

  expect(createExactScrubber([secret])(JSON.stringify({ echoed: secret }))).toBe(
    '{"echoed":"[REDACTED]"}',
  );
});

test('an exact scrubber given an empty value leaves the text alone', () => {
  // An empty needle would have `replaceAll` insert a censor between every character.
  expect(createExactScrubber(['', 'tok'])('a tok b')).toBe('a [REDACTED] b');
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
