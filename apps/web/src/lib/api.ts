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

/** What to show a human when the gateway says no, or says nothing at all. */
export function describeError(error: unknown): string {
  if (error instanceof GatewayError) {
    return error.status === 0 ? error.message : `${error.message} (HTTP ${error.status})`;
  }
  if (error instanceof Error) {
    return `${gatewayUrl()} is unreachable: ${error.message}`;
  }

  return 'the gateway could not be reached';
}
