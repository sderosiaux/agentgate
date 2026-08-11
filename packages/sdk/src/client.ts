import {
  AgentGateSdkError,
  ApprovalNotGrantedError,
  ApprovalTimeoutError,
  asRefusal,
  MalformedResponseError,
  TimeoutError,
  toSdkError,
  TransportError,
} from './errors.js';

export interface AgentGateOptions {
  /** Where the gateway is, from inside the sandbox. Nothing else is reachable from there. */
  gatewayUrl: string;
  /** The mission-bound agent token. One token, one mission (D9). */
  token: string;
  /**
   * How long one call may take before it is abandoned. Defaults to
   * {@link DEFAULT_REQUEST_TIMEOUT_MS}.
   *
   * There is no such thing as waiting this out: the gateway is the agent's only route anywhere,
   * so a gateway that accepts a connection and goes silent is an agent that never runs again.
   * A bound is not a tuning knob here, it is the difference between a failure and a hang.
   */
  timeoutMs?: number | undefined;
}

/**
 * What an agent asks for. `url` is the *logical* url — `https://api.github.com/...` — never the
 * address of whatever the gateway forwards to: the agent names the service it means, and where
 * that lives is a property of the credential (D2).
 */
export interface ProxyRequest {
  /** The alias of a credential the agent never holds. */
  credential: string;
  method: string;
  url: string;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
  /** The grant a human issued, on the retry of a request that needed one (D7). */
  approvalId?: string | undefined;
  /**
   * The caller's own cancellation, honoured alongside the client's timeout. An agent shutting
   * down should not have to wait for whichever of the two is longer.
   */
  signal?: AbortSignal | undefined;
}

export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  /** The upstream body, verbatim. */
  body: string;
  json<T>(): T;
}

export const APPROVAL_STATUSES = ['pending', 'approved', 'denied', 'expired', 'consumed'] as const;

export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** What an agent may know about the approval it is waiting on. */
export interface ApprovalView {
  id: string;
  status: ApprovalStatus;
  resource: string;
  action: string;
  requestedAt: string;
  decidedAt?: string;
}

export interface WaitForApprovalOptions {
  timeoutMs?: number | undefined;
  intervalMs?: number | undefined;
}

/**
 * Long enough for a slow upstream the gateway is still waiting on — its own forward timeout is
 * 10 seconds — and short enough that a silent gateway is a failure within the minute.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Long enough for a human to look at a queue, short enough that a stuck agent stops. */
const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
const DEFAULT_APPROVAL_INTERVAL_MS = 1_000;

/** A status the wait can end on. Everything else means "still waiting". */
const SETTLED: Record<string, boolean> = {
  approved: true,
  denied: true,
  expired: true,
  consumed: true,
};

/** What one HTTP call gave back, already read. The shape every method here reasons about. */
interface RawAnswer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function headersToRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The whole client surface an agent needs, and deliberately nothing more: it can ask for a
 * request to be made on its behalf, and it can find out whether the human said yes. There is no
 * method here that takes a credential value, because there is no code path in AgentGate where an
 * agent would have one to pass.
 */
export class AgentGate {
  // `#` rather than `private`: TypeScript's `private` is a compile-time promise and a runtime
  // enumerable property, so `JSON.stringify(client)` — in a log line, an error report, a crash
  // dump — would print the mission token. This class is instantiated inside the sandbox, which
  // is exactly the place where that is not a theoretical concern.
  readonly #gatewayUrl: string;
  readonly #token: string;
  readonly #timeoutMs: number;

  constructor(options: AgentGateOptions) {
    if (options.gatewayUrl === '') {
      throw new AgentGateSdkError('gatewayUrl is required', {
        code: 'agentgate_sdk_misconfigured',
      });
    }
    if (options.token === '') {
      throw new AgentGateSdkError('token is required', { code: 'agentgate_sdk_misconfigured' });
    }

    this.#gatewayUrl = trimTrailingSlash(options.gatewayUrl);
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /**
   * Sends one request through the gateway. A response comes back only when the gateway decided
   * ALLOW: every refusal is thrown, so an agent that forgets to check a status code still
   * cannot mistake a denial for an empty result.
   *
   * The upstream's own failures are *not* thrown — a 404 from GitHub is an answer, and turning
   * it into an exception would mean an agent cannot tell "you may not ask" from "there is
   * nothing there".
   */
  async request(request: ProxyRequest): Promise<ProxyResponse> {
    const answer = await this.#send(
      'POST',
      '/v1/proxy',
      {
        credential: request.credential,
        method: request.method,
        url: request.url,
        ...(request.headers === undefined ? {} : { headers: request.headers }),
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(request.approvalId === undefined ? {} : { approvalId: request.approvalId }),
      },
      request.signal,
    );

    const refusal = asRefusal(answer.body);

    if (refusal !== null) {
      throw toSdkError(answer.status, refusal);
    }

    const { status, headers, body } = answer;

    return {
      status,
      headers,
      body,
      json<T>(): T {
        try {
          return JSON.parse(body) as T;
        } catch {
          throw new MalformedResponseError('the response body is not json', {
            code: 'agentgate_sdk_invalid_json',
            status,
            requestId: headers['x-agentgate-request-id'],
          });
        }
      },
    };
  }

  /** Where the approval an agent is waiting on has got to. Its own approval, or a 404. */
  async getApproval(approvalId: string, signal?: AbortSignal): Promise<ApprovalView> {
    const answer = await this.#send(
      'GET',
      `/v1/approvals/${encodeURIComponent(approvalId)}`,
      undefined,
      signal,
    );

    const refusal = asRefusal(answer.body);

    if (refusal !== null) {
      throw toSdkError(answer.status, refusal);
    }

    const malformed = (reason: string): MalformedResponseError =>
      new MalformedResponseError(reason, {
        code: 'agentgate_sdk_invalid_approval',
        status: answer.status,
        requestId: answer.headers['x-agentgate-request-id'],
      });

    let parsed: unknown;
    try {
      parsed = JSON.parse(answer.body);
    } catch {
      throw malformed('the approval endpoint did not answer with json');
    }

    const view = parsed as Partial<ApprovalView>;

    // Checked rather than cast. An unrecognised status is not "still pending", but that is
    // exactly what it became: `waitForApproval` would poll something it had no meaning for
    // until it timed out, and report a human who never answered.
    if (typeof view.status !== 'string' || !APPROVAL_STATUSES.includes(view.status as never)) {
      throw malformed(
        `the approval endpoint reported a status this client does not know: ${String(view.status)}`,
      );
    }

    return view as ApprovalView;
  }

  /**
   * Waits until the approval is usable, or explains why it never will be. Returns on `approved`
   * and throws on everything else that settles — a denial, a grant that expired unspent, one
   * already used — so the only way past this call is a request the agent may now retry.
   *
   * Polling, not a subscription: an agent behind a gateway it can only reach over HTTP has no
   * channel to be pushed on, and one request a second for the length of a human's attention is
   * cheaper than the machinery that would avoid it.
   */
  async waitForApproval(approvalId: string, options: WaitForApprovalOptions = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    const intervalMs = options.intervalMs ?? DEFAULT_APPROVAL_INTERVAL_MS;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const approval = await this.getApproval(approvalId);

      if (approval.status === 'approved') {
        return;
      }

      if (SETTLED[approval.status] === true) {
        throw new ApprovalNotGrantedError(
          `approval ${approvalId} is ${approval.status}`,
          approval.status,
          { code: 'agentgate_approval_not_granted' },
        );
      }

      if (Date.now() + intervalMs > deadline) {
        throw new ApprovalTimeoutError(
          `approval ${approvalId} was not decided within ${String(timeoutMs)}ms`,
          { code: 'agentgate_sdk_approval_timeout' },
        );
      }

      await sleep(intervalMs);
    }
  }

  /**
   * One call, from the socket to a body read in full — under one deadline.
   *
   * The read is inside the timeout on purpose: a gateway that sends headers and then stops
   * sending bytes hangs an agent exactly as thoroughly as one that never answers, and a timeout
   * that stops at the headers would not notice.
   */
  async #send(
    method: 'GET' | 'POST',
    path: string,
    payload: unknown,
    callerSignal?: AbortSignal | undefined,
  ): Promise<RawAnswer> {
    // Its own timer per call, unref'd by the platform, so a client sitting idle does not keep a
    // process alive on the strength of a request it already finished.
    const expiry = AbortSignal.timeout(this.#timeoutMs);
    const signal = callerSignal === undefined ? expiry : AbortSignal.any([expiry, callerSignal]);

    try {
      const response = await fetch(`${this.#gatewayUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal,
      });

      return {
        status: response.status,
        headers: headersToRecord(response.headers),
        body: await response.text(),
      };
    } catch (error) {
      // Which of the two signals fired is the difference between "try again" and "you asked me
      // to stop", and a caller cancelling its own request must never be reported as the gateway
      // being slow.
      if (expiry.aborted) {
        throw new TimeoutError(
          `the gateway at ${this.#gatewayUrl} did not answer within ${String(this.#timeoutMs)}ms`,
          { code: 'agentgate_sdk_timeout' },
        );
      }
      if (callerSignal?.aborted === true) {
        throw new TransportError(`the request to ${this.#gatewayUrl}${path} was cancelled`, {
          code: 'agentgate_sdk_cancelled',
        });
      }

      // The gateway is the agent's only way out of its sandbox, so "I could not reach it" is
      // worth saying in those words rather than letting a bare `TypeError: fetch failed` reach
      // an agent that has no other route to try.
      throw new TransportError(
        `the gateway at ${this.#gatewayUrl} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        { code: 'agentgate_sdk_unreachable' },
      );
    }
  }
}
