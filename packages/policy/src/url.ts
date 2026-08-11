import { AgentGateError } from '@agentgate/shared';

export interface NormalizedUrl {
  /** Lowercased, port dropped, trailing dot removed. For matching, not for dialling. */
  host: string;
  /**
   * The logical path: percent-decoded, `.`/`..` collapsed, query and fragment gone.
   *
   * This is what policy is decided ON, never what a request is forwarded WITH. The gateway
   * must proxy the ORIGINAL url and query string — rebuilding a request from this string
   * would re-encode a path the upstream would then read differently, which is precisely the
   * gap that lets a decision be made about one path while another one is served.
   */
  path: string;
  protocol: 'http:' | 'https:';
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Characters that make the raw string and the parsed url disagree about the path.
 *
 * Whitespace and control characters because url parsing silently strips them. Backslash
 * because url parsing reads it as a path separator for http(s): `https://host\evil/repos/a/b`
 * resolves to `/evil/repos/a/b` upstream, while reading the raw string gives `/repos/a/b` —
 * a policy decision about a path nobody serves. Refusing beats picking a winner.
 *
 * Tested against the raw url and again against the decoded path, so `%5c` is caught too.
 */
const FORBIDDEN_CHARS = /[\u0000-\u0020\u007f\\]/;

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
    invalid('request url must not contain whitespace, control characters or a backslash');
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

  // `example.com.` and `example.com` are the same host to DNS, and url parsing keeps the dot.
  // The fully qualified form is the one valid alternative spelling, so it is folded onto the
  // plain one; every other arrangement of dots — `com..`, `a..b`, a leading dot — is not a
  // valid hostname at all, and stripping instead of rejecting would just invent a third
  // spelling of a name a deny rule already covers.
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (host === '') {
    invalid('request url must name a host');
  }
  if (host.split('.').includes('')) {
    invalid('request url host must not contain an empty label');
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
    invalid('request path must not decode to whitespace, control characters or a backslash');
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
    host,
    path: `/${segments.join('/')}`,
    protocol: parsed.protocol as 'http:' | 'https:',
  };
}
