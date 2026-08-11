import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';

const CENSOR = '[REDACTED]';

/**
 * Values short enough to be ordinary words are not registered: scrubbing `admin` out of every
 * log line would destroy far more than it protects, and a credential that short is not one.
 */
const MIN_SENSITIVE_LENGTH = 8;

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

/** Removes every registered value from an already-serialised log line. */
export function scrubSensitive(line: string): string {
  let scrubbed = line;

  for (const value of sensitiveValues) {
    if (scrubbed.includes(value)) {
      // A function replacement: `$&` and friends inside a secret must not be read as match
      // references, exactly as in `applyInjection`.
      scrubbed = scrubbed.replaceAll(value, () => CENSOR);
    }
  }

  return scrubbed;
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
