import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';

const CENSOR = '[REDACTED]';

/**
 * Values short enough to be ordinary words are not registered: scrubbing `admin` out of every
 * log line would destroy far more than it protects, and a credential that short is not one.
 */
export const MIN_SENSITIVE_LENGTH = 8;

/**
 * Every credential value the gateway has decrypted in this process. `SecretStore` fills it on
 * each resolve, so the scrubber knows the exact strings that must never reach a log — whatever
 * key they end up under, and whichever code path put them there.
 *
 * Bounded by the credential table, which is why nothing is ever evicted: forgetting a value
 * would silently stop scrubbing it.
 */
const sensitiveValues = new Set<string>();

/**
 * Teaches the scrubber one more string to remove from every log line.
 *
 * The json-escaped spelling is registered alongside the raw one: a secret carrying a quote or
 * a backslash is not a substring of the serialised line, so matching only the raw form would
 * miss precisely the values whose shape makes them hardest to notice.
 */
export function registerSensitive(value: string): void {
  if (value.length < MIN_SENSITIVE_LENGTH) {
    return;
  }

  sensitiveValues.add(value);

  const escaped = JSON.stringify(value).slice(1, -1);
  if (escaped !== value) {
    sensitiveValues.add(escaped);
  }
}

function removeAll(text: string, values: Iterable<string>): string {
  let scrubbed = text;

  for (const value of values) {
    // An empty needle would have `replaceAll` insert the censor between every character.
    if (value.length > 0 && scrubbed.includes(value)) {
      // A function replacement: `$&` and friends inside a secret must not be read as match
      // references, exactly as in `applyInjection`.
      scrubbed = scrubbed.replaceAll(value, () => CENSOR);
    }
  }

  return scrubbed;
}

/** Removes every registered value from an already-serialised log line. */
export function scrubSensitive(line: string): string {
  return removeAll(line, sensitiveValues);
}

/**
 * A scrubber for a known, bounded set of strings — whatever their length.
 *
 * {@link MIN_SENSITIVE_LENGTH} guards the *global* set, because a three-character string
 * registered there would be struck out of every log line the process ever writes, including all
 * the ones that merely happen to contain those three characters. That reasoning is about reach,
 * not about how much a short credential deserves to be hidden: where the values are exact and
 * the text is one response the gateway is about to hand back, there is nothing unrelated to
 * damage, so no length threshold applies.
 *
 * Longest first, so a value that contains another — `Bearer <token>` around `<token>` — is
 * struck out as one censor rather than leaving `Bearer [REDACTED]` behind.
 */
export function createExactScrubber(values: readonly string[]): (text: string) => string {
  const needles = new Set<string>();

  for (const value of values) {
    if (value.length === 0) {
      continue;
    }

    needles.add(value);

    // Same reason as `registerSensitive`: inside a json body, a value carrying a quote or a
    // backslash is present only in its escaped spelling.
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) {
      needles.add(escaped);
    }
  }

  const ordered = [...needles].sort((a, b) => b.length - a.length);

  return (text: string) => removeAll(text, ordered);
}

/**
 * Keys that carry credential material by convention, whatever the value happens to be. This
 * catches the header of a request the gateway has not decrypted anything for — an agent's own
 * JWT, an upstream's `WWW-Authenticate` challenge — which no registered value would cover.
 */
export const REDACT_PATHS = [
  'headers.authorization',
  '*.headers.authorization',
  '*.*.headers.authorization',
  '*.value',
  '*.token',
  '*.secret',
];

export interface GatewayLoggerOptions extends LoggerOptions {
  /** Where the lines go. Tests capture them; production leaves it on stdout. */
  destination?: DestinationStream;
}

/**
 * The gateway's logger. Two layers, because neither is enough on its own: `redact` handles the
 * keys known to hold credentials, and `streamWrite` sweeps the fully serialised line for values
 * the store has actually decrypted — the only layer that reaches a message body or a stack
 * trace, which is where a secret leaks when someone interpolates it into an error.
 */
export function createLogger(options: GatewayLoggerOptions = {}): Logger {
  const { destination, ...loggerOptions } = options;

  const base: LoggerOptions = {
    level: process.env['LOG_LEVEL'] ?? 'info',
    redact: { paths: REDACT_PATHS, censor: CENSOR },
    hooks: { streamWrite: scrubSensitive },
    ...loggerOptions,
  };

  return destination === undefined ? pino(base) : pino(base, destination);
}
