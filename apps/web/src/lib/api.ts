import 'server-only';

import type {
  Agent,
  AgentDetail,
  Approval,
  AuditEvent,
  Credential,
  DecisionRecord,
  Mission,
  MissionDetail,
  Overview,
  Page,
  Principal,
} from './types';

/**
 * The console's one door to the gateway.
 *
 * `server-only` at the top of this file is the enforcement of the rule the whole app is built
 * around: `ADMIN_TOKEN` is read here and nowhere else, and a client component that imports this
 * module fails the build instead of shipping the token to a browser. Every interactive control
 * goes through a route handler under `src/app/api`, which is server code that calls in here.
 */

/** Where the gateway answers. The compose default; overridden by env for host-side dev. */
const DEFAULT_GATEWAY_URL = 'http://gateway:8080';

/** Read per call, not at module load: the container gets its environment at run time. */
function gatewayUrl(): string {
  return process.env.GATEWAY_URL ?? DEFAULT_GATEWAY_URL;
}

/**
 * The gateway reduced to the one part of it that may be shown to a browser.
 *
 * `GATEWAY_URL` is a connection string, and an operator is entitled to write credentials into
 * one — `http://admin:hunter2@gateway:8080` is a perfectly ordinary thing to configure. `URL.host`
 * drops the userinfo along with everything else, leaving the name and port an operator needs to
 * know which gateway they are looking at. Anything rendered into a page goes through here.
 */
export function gatewayHost(): string {
  const configured = gatewayUrl();

  try {
    return new URL(configured).host;
  } catch {
    // Not a URL at all, so it cannot be parsed apart — and must not be printed whole either.
    return 'the configured gateway';
  }
}

function adminToken(): string {
  const token = process.env.ADMIN_TOKEN;

  if (token === undefined || token === '') {
    // Refused loudly rather than sent as an empty bearer: every management route would answer
    // 401 and the console would look broken for a reason nobody could see from the outside.
    throw new GatewayError(
      0,
      'ADMIN_TOKEN is not set on the web service, so this console cannot talk to the gateway',
    );
  }

  return token;
}

/** What the management API sends when it refuses (`ErrorBodySchema`). */
interface GatewayErrorBody {
  error?: string;
  reason?: string;
  request_id?: string;
}

export class GatewayError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly requestId: string | undefined;

  constructor(status: number, message: string, code?: string, requestId?: string) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

type Query = Record<string, string | number | undefined>;

function url(path: string, query?: Query): string {
  const target = new URL(`/api/v1${path}`, gatewayUrl());

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== '') {
      target.searchParams.set(key, String(value));
    }
  }

  return target.toString();
}

async function refusal(response: Response): Promise<GatewayError> {
  let body: GatewayErrorBody = {};
  try {
    body = (await response.json()) as GatewayErrorBody;
  } catch {
    // A refusal that is not JSON is still a refusal; the status carries the meaning.
  }

  return new GatewayError(
    response.status,
    body.reason ?? `gateway answered ${response.status}`,
    body.error,
    body.request_id,
  );
}

async function request<T>(path: string, init: RequestInit, query?: Query): Promise<T> {
  const response = await fetch(url(path, query), {
    ...init,
    headers: {
      ...init.headers,
      authorization: `Bearer ${adminToken()}`,
      accept: 'application/json',
    },
    // An authorization console shows what is true now. Nothing here is cacheable.
    cache: 'no-store',
  });

  if (!response.ok) {
    throw await refusal(response);
  }

  return (await response.json()) as T;
}

function get<T>(path: string, query?: Query): Promise<T> {
  return request<T>(path, { method: 'GET' }, query);
}

/**
 * Every management POST this console makes.
 *
 * The empty object is not decoration: these routes declare a JSON body schema, and a POST that
 * announces `content-type: application/json` while sending nothing is answered with 400. The
 * console never has anything to add to an approve, a deny, an expire or a mint, so `{}` is both
 * the smallest and the only correct body.
 */
function post<T>(path: string): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}

export const api = {
  overview: (): Promise<Overview> => get<Overview>('/stats/overview'),

  principals: async (): Promise<Principal[]> =>
    (await get<{ principals: Principal[] }>('/principals')).principals,

  agents: async (): Promise<Agent[]> => (await get<{ agents: Agent[] }>('/agents')).agents,

  agent: (id: string): Promise<AgentDetail> =>
    get<AgentDetail>(`/agents/${encodeURIComponent(id)}`),

  missions: async (query?: { agentId?: string; status?: string }): Promise<Mission[]> =>
    (await get<{ missions: Mission[] }>('/missions', query)).missions,

  mission: (id: string): Promise<MissionDetail> =>
    get<MissionDetail>(`/missions/${encodeURIComponent(id)}`),

  expireMission: (id: string): Promise<Mission> =>
    post<Mission>(`/missions/${encodeURIComponent(id)}/expire`),

  /**
   * Mints a token and deliberately drops it. The caller gets the session it belongs to and when
   * it dies, never the token itself: an agent's token reaches the agent through the SDK, and a
   * console that prints one turns a browser tab into a place credentials live.
   */
  mintToken: async (id: string): Promise<{ sessionId: string; expiresAt: string }> => {
    const minted = await post<{ token: string; sessionId: string; expiresAt: string }>(
      `/missions/${encodeURIComponent(id)}/tokens`,
    );

    return { sessionId: minted.sessionId, expiresAt: minted.expiresAt };
  },

  credentials: async (): Promise<Credential[]> =>
    (await get<{ credentials: Credential[] }>('/credentials')).credentials,

  approvals: async (query?: {
    status?: string | undefined;
    missionId?: string | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
  }): Promise<Page<Approval>> => {
    const page = await get<{ approvals: Approval[]; nextCursor: string | null }>(
      '/approvals',
      query,
    );

    return { items: page.approvals, nextCursor: page.nextCursor };
  },

  approve: (id: string): Promise<Approval> =>
    post<Approval>(`/approvals/${encodeURIComponent(id)}/approve`),

  deny: (id: string): Promise<Approval> =>
    post<Approval>(`/approvals/${encodeURIComponent(id)}/deny`),

  // Every filter is `| undefined` rather than merely optional: callers build these from search
  // parameters, where "absent" is a value they hold rather than a key they omit.
  audit: async (query?: {
    agentId?: string | undefined;
    principalId?: string | undefined;
    missionId?: string | undefined;
    resource?: string | undefined;
    decision?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
  }): Promise<Page<AuditEvent>> => {
    const page = await get<{ events: AuditEvent[]; nextCursor: string | null }>('/audit', query);

    return { items: page.events, nextCursor: page.nextCursor };
  },

  decision: (requestId: string): Promise<DecisionRecord> =>
    get<DecisionRecord>(`/decisions/${encodeURIComponent(requestId)}`),
};

/**
 * A transport failure's code, when it has one worth repeating.
 *
 * Only a bare screaming-snake token — `ECONNREFUSED`, `ENOTFOUND` — is taken. The message beside
 * it is not: undici builds those by embedding the URL it was given, so repeating one puts the
 * connection string, credentials and all, back into the page this function feeds.
 */
function failureCode(error: unknown): string | null {
  // Walked rather than read at a fixed depth: the runtime wraps a connection failure more than
  // once, so `ECONNREFUSED` sits at whatever level this particular stack happens to put it.
  let carrier: unknown = error;

  for (let depth = 0; depth < 5 && carrier !== null && carrier !== undefined; depth += 1) {
    const { code, cause } = carrier as { code?: unknown; cause?: unknown };

    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code)) {
      return code;
    }

    carrier = cause;
  }

  return null;
}

/**
 * What to show a human when the gateway says no, or says nothing at all.
 *
 * Whatever this returns is rendered into HTML the browser receives, so it is written under the
 * same rule as everything else here: the host, never the URL. A `GatewayError` carries the
 * gateway's own words, which are safe by construction — that text comes from the management
 * API's `reason` field and never quotes what the console sent.
 */
export function describeError(error: unknown): string {
  if (error instanceof GatewayError) {
    return error.status === 0 ? error.message : `${error.message} (HTTP ${error.status})`;
  }

  const code = failureCode(error);

  return `${gatewayHost()} could not be reached${code === null ? '' : ` (${code})`}`;
}
