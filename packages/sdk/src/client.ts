import {
  AgentGateSdkError,
  AccessDeniedError,
  asRefusal,
  GatewayError,
  toSdkError,
} from './errors.js';

export interface AgentGateOptions {
  /** Where the gateway is, from inside the sandbox. Nothing else is reachable from there. */
  gatewayUrl: string;
  /** The mission-bound agent token. One token, one mission (D9). */
  token: string;
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
  private readonly gatewayUrl: string;
  private readonly token: string;

  constructor(options: AgentGateOptions) {
    if (options.gatewayUrl === '') {
      throw new AgentGateSdkError('gatewayUrl is required', {
        code: 'agentgate_sdk_misconfigured',
      });
    }
    if (options.token === '') {
      throw new AgentGateSdkError('token is required', { code: 'agentgate_sdk_misconfigured' });
    }

    this.gatewayUrl = trimTrailingSlash(options.gatewayUrl);
    this.token = options.token;
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
    const response = await this.send('POST', '/v1/proxy', {
      credential: request.credential,
      method: request.method,
      url: request.url,
      ...(request.headers === undefined ? {} : { headers: request.headers }),
      ...(request.body === undefined ? {} : { body: request.body }),
      ...(request.approvalId === undefined ? {} : { approvalId: request.approvalId }),
    });

    const body = await response.text();
    const refusal = asRefusal(body);

    if (refusal !== null) {
      throw toSdkError(response.status, refusal);
    }

    return {
      status: response.status,
      headers: headersToRecord(response.headers),
      body,
      json<T>(): T {
        try {
          return JSON.parse(body) as T;
        } catch {
          throw new AgentGateSdkError('the response body is not json', {
            code: 'agentgate_sdk_invalid_json',
            status: response.status,
            requestId: response.headers.get('x-agentgate-request-id') ?? undefined,
          });
        }
      },
    };
  }

  /** Where the approval an agent is waiting on has got to. Its own approval, or a 404. */
  async getApproval(approvalId: string): Promise<ApprovalView> {
    const response = await this.send(
      'GET',
      `/v1/approvals/${encodeURIComponent(approvalId)}`,
      undefined,
    );

    const body = await response.text();
    const refusal = asRefusal(body);

    if (refusal !== null) {
      throw toSdkError(response.status, refusal);
    }

    try {
      return JSON.parse(body) as ApprovalView;
    } catch {
      throw new GatewayError('the approval endpoint did not answer with json', {
        code: 'agentgate_sdk_invalid_json',
        status: response.status,
      });
    }
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
        throw new AccessDeniedError(`approval ${approvalId} is ${approval.status}`, {
          code: 'agentgate_approval_not_granted',
        });
      }

      if (Date.now() + intervalMs > deadline) {
        throw new AgentGateSdkError(
          `approval ${approvalId} was not decided within ${String(timeoutMs)}ms`,
          { code: 'agentgate_sdk_approval_timeout' },
        );
      }

      await sleep(intervalMs);
    }
  }

  private async send(method: 'GET' | 'POST', path: string, payload: unknown): Promise<Response> {
    try {
      return await fetch(`${this.gatewayUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
    } catch (error) {
      // The gateway is the agent's only way out of its sandbox, so "I could not reach it" is
      // worth saying in those words rather than letting a bare `TypeError: fetch failed` reach
      // an agent that has no other route to try.
      throw new GatewayError(
        `the gateway at ${this.gatewayUrl} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        { code: 'agentgate_sdk_unreachable' },
      );
    }
  }
}
