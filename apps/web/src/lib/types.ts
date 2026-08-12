/**
 * The management API's wire shapes, as this console reads them.
 *
 * Hand-written rather than generated: the console is a client of a documented REST API, and a
 * type here is a statement about what it is prepared to render. Where the gateway serves a
 * stored admin-authored document (`permissions`, `network`, `limits`), the type is `unknown` on
 * purpose — those columns are JSON, the API reads them back defensively, and so does this UI.
 */

export const DECISIONS = ['ALLOW', 'DENY', 'REQUIRE_APPROVAL', 'ERROR'] as const;

export type Decision = (typeof DECISIONS)[number];

export interface Overview {
  activeAgents: number;
  activeMissions: number;
  requestsToday: number;
  allowedToday: number;
  deniedToday: number;
  pendingApprovals: number;
}

export interface Principal {
  id: string;
  name: string;
}

export interface Agent {
  id: string;
  principalId: string;
  agentType: string;
  createdAt: string;
}

export interface AgentDetail extends Agent {
  activeMission: {
    id: string;
    intent: string;
    status: string;
    expiresAt: string;
  } | null;
  recentAudit: {
    total: number;
    byDecision: Record<string, number>;
    events: {
      id: string;
      requestId: string;
      timestamp: string;
      decision: string;
      reason: string;
      resource: string | null;
      action: string | null;
      httpStatus: number | null;
    }[];
  };
}

export interface Mission {
  id: string;
  principalId: string;
  agentId: string;
  intent: string;
  status: string;
  environment: string;
  /** Admin-authored documents. Rendered defensively; see `src/lib/mission-doc.ts`. */
  permissions: unknown;
  network: unknown;
  limits: unknown;
  expiresAt: string;
  createdAt: string;
}

export interface MissionDetail extends Mission {
  usage: {
    requestCount: number;
    bytesTotal: number;
  };
}

/**
 * A credential as the console is allowed to know it. There is no `value`, and there is no
 * endpoint that would return one — the list is the only credential shape this app has a type
 * for, so no component can be written against a field that does not exist here.
 */
export interface Credential {
  id: string;
  alias: string;
  provider: string;
  logicalHost: string;
  upstreamBaseUrl: string;
  injection: { type: string; name: string };
  status: string;
}

export interface Approval {
  id: string;
  missionId: string;
  agentId: string;
  resource: string;
  action: string;
  reason: string;
  requestSummary: {
    method: string;
    host: string;
    path: string;
    bodySize?: number;
    /** Absent on an approval recorded before grants were pinned to a concrete request. */
    bodyHash?: string;
    contentType?: string;
  };
  status: string;
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  grantExpiresAt: string | null;
  consumedAt: string | null;
}

export interface AuditEvent {
  id: string;
  requestId: string;
  timestamp: string;
  principalId: string | null;
  agentId: string | null;
  missionId: string | null;
  resource: string | null;
  action: string | null;
  method: string | null;
  destHost: string | null;
  destPath: string | null;
  decision: string;
  reason: string;
  matchedPolicy: string | null;
  approvalId: string | null;
  httpStatus: number | null;
  latencyMs: number;
  bodySize: number | null;
  bodyHash: string | null;
  contentType: string | null;
}

/**
 * One decision, with the question the engine was asked.
 *
 * `policyInputSnapshot` is null whenever the pipeline refused before reaching a policy — an
 * invalid token, an expired mission, an exhausted budget. That is information, not a gap, and
 * the decision view says so rather than rendering seven empty cards.
 */
export interface DecisionRecord extends AuditEvent {
  policyInputSnapshot: unknown;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
