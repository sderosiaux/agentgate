import { AgentGateError } from '@agentgate/shared';

export interface NormalizedUrl {
  host: string;
  path: string;
  protocol: 'http:' | 'https:';
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Whitespace and control characters: url parsing strips some of them, matching must not guess. */
const FORBIDDEN_CHARS = /[\u0000-\u0020\u007f]/;

function invalid(reason: string): never {
  // The raw url can carry credentials, so no part of it is ever echoed back.
  throw new AgentGateError('agentgate_validation_error', 400, reason);
}

/**
 * The path exactly as it was written, before `new URL` gets a chance to rewrite it.
 *
 * `new URL` resolves `..` itself and clamps at the root instead of failing, and it treats
 * `%2e%2e` as a `..` segment — so reading `pathname` would hand us an already-laundered path
 * and hide the traversal we are supposed to refuse. The scheme has been validated by the
 * caller, so `://` is present.
 */
function rawPathOf(raw: string): string {
  const authorityStart = raw.indexOf('://') + 3;
  let end = raw.length;
  for (const terminator of ['?', '#']) {
    const at = raw.indexOf(terminator, authorityStart);
    if (at !== -1 && at < end) {
      end = at;
    }
  }
  const afterScheme = raw.slice(authorityStart, end);
  const pathStart = afterScheme.indexOf('/');
  return pathStart === -1 ? '/' : afterScheme.slice(pathStart);
}

/**
 * Turns a request url into the single spelling every later stage matches on: network rules,
 * the provider adapters and the audit log all see this and nothing else. Two urls that reach
 * the same upstream path must normalise to the same string, otherwise a deny rule can be
 * walked around with an extra slash or a percent escape.
 *
 * The port is dropped: rules are written about hosts, and keeping `:8443` would silently make
 * `*.github.com` stop matching.
 */
export function normalizeUrl(raw: string): NormalizedUrl {
  if (FORBIDDEN_CHARS.test(raw)) {
    invalid('request url must not contain whitespace or control characters');
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    invalid('request url is not an absolute url');
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    invalid('request url must use http or https');
  }

  if (parsed.username !== '' || parsed.password !== '') {
    invalid('request url must not carry credentials in its authority');
  }

  if (parsed.hostname === '') {
    invalid('request url must name a host');
  }

  let decoded: string;
  try {
    // Once, and only once: decoding until stable would let `%252e%252e` become a traversal
    // that the upstream server would never have seen that way.
    decoded = decodeURIComponent(rawPathOf(raw));
  } catch {
    invalid('request path is not valid percent-encoding');
  }

  if (FORBIDDEN_CHARS.test(decoded)) {
    invalid('request path must not decode to whitespace or control characters');
  }

  const segments: string[] = [];
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (segments.length === 0) {
        invalid('request path escapes the root');
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return {
    host: parsed.hostname.toLowerCase(),
    path: `/${segments.join('/')}`,
    protocol: parsed.protocol as 'http:' | 'https:',
  };
}
