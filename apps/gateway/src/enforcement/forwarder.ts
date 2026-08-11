import { AgentGateError } from '@agentgate/shared';
import { registerSensitive, scrubSensitive } from '../logging.js';
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
  /**
   * How many bytes of response the caller is willing to hold in memory. The pipeline derives it
   * from what is left of the mission's byte budget: reading past that buys nothing, since the
   * mission cannot afford to be charged for it.
   */
  maxResponseBytes: number;
}

export interface ForwardResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  responseBytes: number;
}

/**
 * The upstream sent more than the mission could afford to receive.
 *
 * Carries what was read before the gateway stopped reading, because those bytes crossed the
 * network and the mission is charged for them — a request that fails halfway is not a free one.
 *
 * A 502 rather than a 429: the request was allowed and has already reached the upstream, side
 * effects and all. Telling the agent to retry later would invite it to do that again.
 */
export class UpstreamResponseTooLarge extends AgentGateError {
  constructor(readonly bytesRead: number) {
    super('agentgate_upstream_error', 502, 'upstream response is larger than the mission allows', {
      details: { bytesRead },
    });
    this.name = 'UpstreamResponseTooLarge';
  }
}

/**
 * Reads the response, and stops reading the moment it grows past what the caller allowed.
 *
 * `response.arrayBuffer()` would buffer whatever the upstream feels like sending before anyone
 * could object, and every registered secret is then scanned across all of it. Streaming with a
 * running total means an upstream — compromised, misconfigured, or merely generous — cannot
 * make the gateway hold more than the mission has budget for.
 */
async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();

  // 204, 304 and friends: no stream to read at all.
  if (reader === undefined) {
    return Buffer.alloc(0);
  }

  const chunks: Buffer[] = [];
  let read = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    read += value.byteLength;
    if (read > maxBytes) {
      // Nothing further is pulled from the socket, and the partial body is dropped: a truncated
      // json document is worse to hand an agent than an honest failure.
      await reader.cancel();
      throw new UpstreamResponseTooLarge(read);
    }

    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks);
}

/**
 * The path and query of the agent's url, taken from the string the agent wrote.
 *
 * Never rebuilt from `NormalizedUrl.path`: that string is percent-decoded and has lost its
 * query, so re-encoding it would send the upstream a url the agent never wrote — and a request
 * served at a path policy did not decide about is the whole failure this gateway exists to
 * prevent.
 *
 * Not literally byte for byte on the wire: `fetch` parses this url and collapses `/./` and
 * `/../` itself. That is safe because it collapses them the same way `normalizeUrl` already
 * did, so the two converge on one path — what matters is that the query survives and that no
 * percent escape is decoded and re-encoded between the decision and the request.
 *
 * The url has been through `normalizeUrl`, so it has a scheme and carries no whitespace,
 * control character or backslash.
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
      headers[name.toLowerCase()] = scrubSensitive(value);
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

  // Whatever is about to go on the wire must never come back off it. The store registers the
  // values it decrypts, but registering here too covers any credential that reached the
  // forwarder by another road, and it is the value this very call is putting at risk.
  registerSensitive(request.injected.value);

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
    payload = await readCapped(response, request.maxResponseBytes);
  } catch (error) {
    if (error instanceof UpstreamResponseTooLarge) {
      throw error;
    }

    throw new AgentGateError('agentgate_upstream_error', 502, 'upstream response was cut short', {
      cause: error,
    });
  }

  return {
    status: response.status,
    headers: returnedHeaders(response),
    // Decoded as utf-8, which is a claim about the upstreams this gateway can talk to rather
    // than about http: bytes that are not text come back with U+FFFD where they were, silently.
    // It holds because a request only reaches here after a provider adapter mapped it, and
    // every adapter in the MVP maps a JSON API (D4) — so the set of reachable responses is the
    // set of JSON responses. An adapter for a binary endpoint would have to make this
    // conditional on the response content type; the characterisation test in
    // test/forwarder.test.ts pins the corruption so that change cannot pass unnoticed.
    // An upstream that reflects the request — an echo endpoint, a debug route, a service that
    // quotes the header it rejected — hands the injected credential straight back, and this
    // body goes to the agent. Logs are not the only place a secret can escape from, so the
    // same scrub the logger uses runs over what the agent is about to be told.
    body: scrubSensitive(payload.toString('utf8')),
    // Counted before scrubbing: the byte budget is about what crossed the network, not about
    // what is left after the gateway has redacted it.
    responseBytes: payload.byteLength,
  };
}
