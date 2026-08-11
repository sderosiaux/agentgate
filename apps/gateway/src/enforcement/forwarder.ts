import { AgentGateError } from '@agentgate/shared';
import type { InjectedHeader } from '../secrets/index.js';

/** A policy call and a forward both sit on the request path: a hung upstream must not hold it. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The only agent-supplied headers that travel upstream. An allowlist rather than a list of
 * banned names: a denylist has to be right about every header that will ever exist, and being
 * wrong once means an agent gets to shape a request in a way policy never looked at.
 */
const FORWARDED_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-type',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-unmodified-since',
  'user-agent',
  'x-github-api-version',
]);

/**
 * What comes back to the agent. Everything else is dropped: an upstream `set-cookie` or
 * `www-authenticate` describes a session the agent must never hold, and a header the agent
 * cannot see is one it cannot be steered by.
 */
const RETURNED_RESPONSE_HEADERS = new Set([
  'content-type',
  'etag',
  'last-modified',
  'link',
  'retry-after',
  'x-github-media-type',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-request-id',
]);

export interface ForwardRequest {
  method: string;
  /**
   * The agent's url, verbatim. Path and query travel to the upstream exactly as written —
   * see {@link upstreamTarget}.
   */
  url: string;
  /** From the credential record: the physical service standing in for the logical host (D2). */
  upstreamBaseUrl: string;
  headers: Record<string, string> | undefined;
  body: string | undefined;
  /** Built by `applyInjection` from the resolved credential. Overrides any agent header. */
  injected: InjectedHeader;
  /** Gateway-minted, echoed to the agent and stored on the audit row. */
  requestId: string;
  timeoutMs?: number;
}

export interface ForwardResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  responseBytes: number;
}

/**
 * The path and query of the agent's url, byte for byte.
 *
 * Never rebuilt from `NormalizedUrl.path`: that string is percent-decoded, `..`-collapsed and
 * has lost its query, so re-encoding it would send the upstream a url the agent never wrote —
 * and a request served at a path policy did not decide about is the whole failure this
 * gateway exists to prevent. The url has been through `normalizeUrl`, so it has a scheme and
 * carries no whitespace, control character or backslash.
 */
function pathAndQueryOf(url: string): string {
  const afterScheme = url.slice(url.indexOf('://') + 3);

  // A fragment is a client-side concept and is never put on the wire.
  const fragment = afterScheme.indexOf('#');
  const addressed = fragment === -1 ? afterScheme : afterScheme.slice(0, fragment);

  const start = addressed.search(/[/?]/);
  if (start === -1) {
    return '/';
  }

  const tail = addressed.slice(start);

  // `https://api.github.com?page=2` addresses the root with a query, not a pathless resource.
  return tail.startsWith('?') ? `/${tail}` : tail;
}

/** Resolves the logical url the agent asked for onto the physical upstream (D2). */
export function upstreamTarget(upstreamBaseUrl: string, url: string): string {
  return `${upstreamBaseUrl.replace(/\/+$/, '')}${pathAndQueryOf(url)}`;
}

/**
 * The headers the upstream will see.
 *
 * The agent's own `Authorization` is its AgentGate token: forwarding it would hand the
 * upstream a credential for this gateway, and would let an agent try its luck against the
 * upstream's own auth. It is dropped like every other header outside the allowlist, and the
 * injected credential is written last so nothing an agent sends can shadow it.
 */
export function buildUpstreamHeaders(
  agentHeaders: Record<string, string> | undefined,
  injected: InjectedHeader,
  requestId: string,
): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const [name, value] of Object.entries(agentHeaders ?? {})) {
    const lowercased = name.toLowerCase();
    if (FORWARDED_REQUEST_HEADERS.has(lowercased)) {
      headers[lowercased] = value;
    }
  }

  // Minted by the gateway, never taken from the agent: the audit trail correlates on it, and a
  // caller that could choose it could make two attempts look like one.
  headers['x-request-id'] = requestId;
  headers[injected.name.toLowerCase()] = injected.value;

  return headers;
}

function returnedHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};

  response.headers.forEach((value, name) => {
    if (RETURNED_RESPONSE_HEADERS.has(name.toLowerCase())) {
      headers[name.toLowerCase()] = value;
    }
  });

  return headers;
}

/**
 * Sends the authorized request to the upstream and buffers what comes back.
 *
 * Buffered rather than streamed: `maxBytes` counts response bodies, the audit row records the
 * status of a completed exchange, and MVP payloads are API responses. Streaming would be the
 * change to make for large artifacts, and it would move byte accounting to the end of a
 * response that has already reached the agent.
 */
export async function forward(request: ForwardRequest): Promise<ForwardResult> {
  const target = upstreamTarget(request.upstreamBaseUrl, request.url);
  const method = request.method.toUpperCase();

  let response: Response;
  try {
    response = await fetch(target, {
      method,
      headers: buildUpstreamHeaders(request.headers, request.injected, request.requestId),
      // A body on GET or HEAD is rejected by fetch itself, and no adapter maps one.
      ...(request.body === undefined || method === 'GET' || method === 'HEAD'
        ? {}
        : { body: request.body }),
      redirect: 'manual',
      signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    // The target is not echoed: it is a private address, and the agent asked about a logical
    // host. The cause carries it into the logs, which the scrubber has already seen.
    throw new AgentGateError('agentgate_upstream_error', 502, 'upstream service is unreachable', {
      cause: error,
    });
  }

  let payload: Buffer;
  try {
    payload = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw new AgentGateError('agentgate_upstream_error', 502, 'upstream response was cut short', {
      cause: error,
    });
  }

  return {
    status: response.status,
    headers: returnedHeaders(response),
    body: payload.toString('utf8'),
    responseBytes: payload.byteLength,
  };
}
