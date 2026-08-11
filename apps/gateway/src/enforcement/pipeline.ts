import { createHash } from 'node:crypto';
import type { TokenService } from '@agentgate/auth';
import {
  matchNetworkRules,
  normalizeUrl,
  type NetworkRule,
  type PolicyEngine,
  type PolicyInput,
  type ProviderAdapter,
} from '@agentgate/policy';
import {
  AgentGateError,
  MissionLimitsSchema,
  MissionPermissionsSchema,
  NetworkRulesSchema,
  type AgentGateErrorCode,
  type MissionLimits,
  type MissionPermissions,
  type NetworkRules,
} from '@agentgate/shared';
import { z } from 'zod';
import type { AuditDecision, AuditRecorder } from '../audit/recorder.js';
import type { PrismaClient } from '../db.js';
import type { SecretStore } from '../secrets/index.js';
import { applyInjection } from '../secrets/index.js';
import { forward } from './forwarder.js';
import { bytesExceeded, consumeRequestSlot, recordBytes } from './limits.js';

/**
 * Pinned to the shared `HttpMethod`: mission network rules are written with these spellings, so
 * a method this list accepts and that list cannot express would be a rule nobody can write.
 * Case is folded first — the wire says `GET`, and an agent writing `get` means the same thing.
 */
const MethodSchema = z
  .string()
  .transform((method) => method.toUpperCase())
  .pipe(z.enum(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']));

/**
 * The agent-facing contract (D1). Strict: a field the gateway does not understand is a request
 * it cannot reason about, and answering it anyway is how an unchecked knob gets shipped.
 */
const ProxyRequestSchema = z.strictObject({
  credential: z.string().min(1),
  method: MethodSchema,
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  /** Plan 07. Accepted by the contract today, and not yet consumed by anything. */
  approvalId: z.string().optional(),
});

export type ProxyRequestBody = z.infer<typeof ProxyRequestSchema>;

function parseProxyRequest(attempt: Attempt, rawBody: unknown): ProxyRequestBody {
  const parsed = ProxyRequestSchema.safeParse(rawBody);

  if (!parsed.success) {
    attempt.matchedPolicy = 'request-invalid-envelope';
    throw new AgentGateError(
      'agentgate_validation_error',
      400,
      'proxy request body is not well formed',
      { decision: 'DENY', cause: parsed.error },
    );
  }

  return parsed.data;
}

/**
 * `normalizeUrl` refuses a url the gateway cannot reason about — no scheme, a traversal, an
 * authority carrying credentials. Wrapped only to tag the attempt: a refusal that leaves the
 * trail saying nothing about which stage made it is a refusal nobody can audit.
 */
function normalizeRequestUrl(attempt: Attempt, url: string): ReturnType<typeof normalizeUrl> {
  try {
    return normalizeUrl(url);
  } catch (error) {
    attempt.matchedPolicy = 'request-invalid-url';
    throw error;
  }
}

export interface PipelineDeps {
  prisma: PrismaClient;
  tokenService: TokenService;
  secretStore: SecretStore;
  engine: PolicyEngine;
  adapters: ProviderAdapter[];
  audit: AuditRecorder;
  /** Injected so mission expiry is a decision about a time, not about the wall clock. */
  clock: () => Date;
  environment: string;
}

export interface ProxyOutcome {
  status: number;
  headers: Record<string, string>;
  /** An upstream body, verbatim, or an `AgentGateErrorBody`. */
  body: string | object;
  requestId: string;
  /** What the trail says about this attempt, so the caller can log it without re-deriving it. */
  decision: AuditDecision;
  reason: string;
}

/**
 * How a refusal is written down. `DENY` is a decision the gateway made and stands behind;
 * `ERROR` means it never reached one, which is a different thing to read in the trail and a
 * different thing to page someone about.
 */
const AUDIT_DECISION_BY_CODE: Record<AgentGateErrorCode, AuditDecision> = {
  agentgate_access_denied: 'DENY',
  agentgate_approval_required: 'REQUIRE_APPROVAL',
  agentgate_invalid_token: 'DENY',
  agentgate_mission_expired: 'DENY',
  agentgate_limit_exceeded: 'DENY',
  agentgate_unknown_credential: 'DENY',
  agentgate_unmapped_action: 'DENY',
  agentgate_validation_error: 'DENY',
  agentgate_not_found: 'DENY',
  agentgate_upstream_error: 'ERROR',
};

/** What the audit row knows so far. Filled as the pipeline learns it, written exactly once. */
interface Attempt {
  requestId: string;
  startedAt: number;
  /** Unknown until the request body has been read, which is after the token is checked. */
  method?: string;
  principalId?: string;
  agentId?: string;
  missionId?: string;
  resource?: string;
  action?: string;
  destHost?: string;
  destPath?: string;
  contentType?: string;
  bodySize?: number;
  bodyHash?: string;
  /**
   * Which rule decided. From the engine when it got that far, and from the pipeline stage that
   * refused otherwise: reading a trail is asking "why", and `null` is not an answer.
   */
  matchedPolicy?: string;
}

function denied(
  attempt: Attempt,
  matchedPolicy: string,
  reason: string,
  code: AgentGateErrorCode = 'agentgate_access_denied',
): never {
  attempt.matchedPolicy = matchedPolicy;

  throw new AgentGateError(code, 403, reason, { decision: 'DENY' });
}

/**
 * The single answer to every way a credential can fail to be usable: absent, revoked, or
 * scoped to another host. One wording, so an agent cannot tell which of the three it hit and
 * turn the gateway into a directory of the aliases that exist.
 */
const CREDENTIAL_REFUSAL = (alias: string): string => `credential ${alias} is unknown`;

function bearerToken(header: string | undefined): string {
  const token = /^bearer (.+)$/i.exec(header?.trim() ?? '')?.[1];

  if (token === undefined) {
    throw new AgentGateError('agentgate_invalid_token', 401, 'Agent token is missing');
  }

  return token;
}

function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === name) {
      return value;
    }
  }

  return undefined;
}

/** Long enough for any real media type, short enough that the trail cannot be used as storage. */
const MAX_CONTENT_TYPE_LENGTH = 128;

/**
 * D10: the decision sees metadata about the body, never the body. A future DLP stage is the
 * thing that would look inside, and it slots in here without changing the contract.
 */
function describeBody(
  request: ProxyRequestBody,
): Pick<Attempt, 'bodySize' | 'bodyHash' | 'contentType'> {
  // The header comes from the request body, where nothing bounds its length: the audit column
  // does not, either, and an append-only table is a poor place to let a caller write freely.
  const contentType = headerValue(request.headers, 'content-type')?.slice(
    0,
    MAX_CONTENT_TYPE_LENGTH,
  );

  if (request.body === undefined) {
    return { bodySize: 0, ...(contentType === undefined ? {} : { contentType }) };
  }

  return {
    bodySize: Buffer.byteLength(request.body, 'utf8'),
    bodyHash: createHash('sha256').update(request.body, 'utf8').digest('hex'),
    ...(contentType === undefined ? {} : { contentType }),
  };
}

/**
 * A network rule as the mission wrote it, so a refusal can name the rule that decided rather
 * than only the request that lost. Nothing is invented: an absent path or method clause is
 * left absent, because "matches everything" is what absence already means in the document.
 */
function describeRule(rule: NetworkRule): string {
  const methods = rule.methods === undefined ? '' : ` [${rule.methods.join(',')}]`;

  return `${rule.host}${rule.path ?? ''}${methods}`;
}

interface MissionDocuments {
  permissions: MissionPermissions;
  network: NetworkRules;
  limits: MissionLimits;
}

/**
 * The three mission documents live in Json columns, so nothing in the database guarantees their
 * shape. A mission the gateway cannot read grants nothing: this denies rather than failing,
 * because "I could not parse your scope" must never be the reason a request goes through.
 */
function readMissionDocuments(
  attempt: Attempt,
  mission: {
    permissions: unknown;
    network: unknown;
    limits: unknown;
  },
): MissionDocuments {
  const permissions = MissionPermissionsSchema.safeParse(mission.permissions);
  const network = NetworkRulesSchema.safeParse(mission.network);
  const limits = MissionLimitsSchema.safeParse(mission.limits);

  if (!permissions.success || !network.success || !limits.success) {
    denied(attempt, 'mission-unreadable', 'mission scope cannot be read');
  }

  return { permissions: permissions.data, network: network.data, limits: limits.data };
}

async function execute(
  deps: PipelineDeps,
  attempt: Attempt,
  authorization: string | undefined,
  rawBody: unknown,
): Promise<ProxyOutcome> {
  // 1 — the token. Anything wrong with it is one answer: the caller is not identified.
  const claims = await deps.tokenService.verify(bearerToken(authorization));
  attempt.agentId = claims.agentId;
  attempt.principalId = claims.principalId;
  attempt.missionId = claims.missionId;

  // 2 — the mission the token is bound to.
  const mission = await deps.prisma.mission.findUnique({ where: { id: claims.missionId } });
  if (mission === null) {
    denied(attempt, 'mission-unknown', 'mission is unknown');
  }
  if (mission.agentId !== claims.agentId || mission.principalId !== claims.principalId) {
    // The token names an identity the mission was not issued to. One token, one mission (D9).
    denied(attempt, 'mission-identity-mismatch', 'token identity does not match the mission');
  }
  if (mission.status === 'revoked') {
    denied(attempt, 'mission-revoked', 'mission has been revoked');
  }

  const now = deps.clock();
  if (mission.expiresAt.getTime() <= now.getTime() || mission.status === 'expired') {
    if (mission.status === 'active') {
      // Marked here rather than by a sweeper: the first request past the deadline is the
      // cheapest place to notice, and the trail should not show an "active" expired mission.
      await deps.prisma.mission.update({
        where: { id: mission.id },
        data: { status: 'expired' },
      });
    }

    attempt.matchedPolicy = 'mission-expired';
    throw new AgentGateError('agentgate_mission_expired', 403, 'mission has expired', {
      decision: 'DENY',
    });
  }
  if (mission.status !== 'active') {
    denied(attempt, 'mission-status', `mission is ${mission.status}`);
  }

  const documents = readMissionDocuments(attempt, mission);

  // 3 — limits, before anything is sent anywhere (D8).
  const slot = await consumeRequestSlot(deps.prisma, mission.id, documents.limits, now);
  if (!slot.ok) {
    attempt.matchedPolicy = `mission-limit-${slot.reason}`;
    throw new AgentGateError(
      'agentgate_limit_exceeded',
      429,
      slot.reason === 'rpm'
        ? 'mission exceeded its requests per minute'
        : 'mission exceeded its request budget',
      { decision: 'DENY', details: { limit: slot.reason } },
    );
  }
  // The envelope, read only once the caller is identified and has paid for the attempt: an
  // unauthenticated or out-of-budget request gets an answer about that, rather than a critique
  // of a body nobody was going to act on. Reading it after the slot is what stops a malformed
  // body from being a free write to an append-only table.
  const request = parseProxyRequest(attempt, rawBody);
  attempt.method = request.method;
  Object.assign(attempt, describeBody(request));

  // The byte budget needs the size of the body, so it can only be checked once there is one.
  if (bytesExceeded(slot.usage, documents.limits, attempt.bodySize ?? 0)) {
    attempt.matchedPolicy = 'mission-limit-max_bytes';
    throw new AgentGateError('agentgate_limit_exceeded', 429, 'mission exceeded its byte budget', {
      decision: 'DENY',
      details: { limit: 'max_bytes' },
    });
  }

  // 4 — one spelling of the url, which every later stage matches on.
  const normalized = normalizeRequestUrl(attempt, request.url);
  attempt.destHost = normalized.host;
  attempt.destPath = normalized.path;

  // 5 — the credential, by metadata only. Nothing is decrypted before a verdict exists.
  const credential = await deps.prisma.credential.findUnique({
    where: { alias: request.credential },
  });
  if (credential === null || credential.status !== 'active') {
    denied(
      attempt,
      'credential-unknown',
      CREDENTIAL_REFUSAL(request.credential),
      'agentgate_unknown_credential',
    );
  }
  if (credential.logicalHost.toLowerCase() !== normalized.host) {
    // The credential names the host it may be used against (D2): an alias for GitHub cannot
    // be pointed at another service by writing a different url.
    //
    // Same words as the two refusals above, on purpose. "Cannot be used for this host" would
    // confirm that the alias exists and is active, which is a question an agent gets to ask
    // once per guess. The trail keeps the three cases apart; the agent sees one answer.
    denied(
      attempt,
      'credential-host-scope',
      CREDENTIAL_REFUSAL(request.credential),
      'agentgate_unknown_credential',
    );
  }

  // 6 — network rules: explicit deny wins, and no rule at all is a deny (D6).
  const network = matchNetworkRules(documents.network, {
    host: normalized.host,
    path: normalized.path,
    method: request.method,
  });
  if (network.matched === 'deny') {
    denied(
      attempt,
      'network-deny-rule',
      `network rule ${describeRule(network.rule)} denies ${request.method} ${normalized.host}${normalized.path}`,
    );
  }
  if (network.matched === 'none') {
    denied(
      attempt,
      'network-default-deny',
      `no network rule allows ${request.method} ${normalized.host}${normalized.path}`,
    );
  }

  // 7 — what the request *is*, decided by the gateway and never by the agent (D4).
  const adapter = deps.adapters.find(
    (candidate) =>
      candidate.provider === credential.provider && candidate.matchesHost(normalized.host),
  );
  const mapped = adapter?.mapRequest(request.method, normalized.path) ?? null;
  if (mapped === null) {
    denied(
      attempt,
      'adapter-unmapped',
      `${request.method} ${normalized.path} maps to no known action`,
      'agentgate_unmapped_action',
    );
  }
  attempt.resource = mapped.resource;
  attempt.action = mapped.action;

  // 8 — the decision itself. Everything above is the question; the engine gives the answer.
  const separator = mapped.resource.indexOf(':');
  const input: PolicyInput = {
    identity: {
      principalId: claims.principalId,
      agentId: claims.agentId,
      agentType: claims.agentType,
    },
    mission: {
      id: mission.id,
      intent: mission.intent,
      permissions: documents.permissions,
      network: documents.network,
      expiresAt: mission.expiresAt.toISOString(),
    },
    resource: {
      provider: mapped.resource.slice(0, separator),
      id: mapped.resource.slice(separator + 1),
    },
    action: { type: mapped.action, method: request.method.toUpperCase() },
    network: { host: normalized.host, path: normalized.path },
    environment: { name: mission.environment },
    currentState: { requestCount: slot.usage.requestCount, bytesTotal: slot.usage.bytesTotal },
    data: {
      ...(attempt.contentType === undefined ? {} : { contentType: attempt.contentType }),
      bodySize: attempt.bodySize ?? 0,
      ...(attempt.bodyHash === undefined ? {} : { bodyHash: attempt.bodyHash }),
    },
  };

  const verdict = await deps.engine.evaluate(input);
  if (verdict.matchedPolicy !== undefined) {
    attempt.matchedPolicy = verdict.matchedPolicy;
  }

  if (verdict.decision === 'DENY') {
    throw new AgentGateError('agentgate_access_denied', 403, verdict.reason, {
      decision: 'DENY',
    });
  }

  if (verdict.decision === 'REQUIRE_APPROVAL') {
    // SEAM FOR PLAN 07 — the approval record, its TTL and the single-use consumption of
    // `request.approvalId` all land here. Today the agent is told to ask a human, and no
    // record is written: an approval that cannot yet be granted must not look pending.
    throw new AgentGateError('agentgate_approval_required', 202, verdict.reason, {
      decision: 'REQUIRE_APPROVAL',
    });
  }

  // 9 — allowed, and only now does a plaintext credential exist in this process.
  const resolved = await deps.secretStore.getByAlias(request.credential);
  if (resolved === null) {
    // Revoked between the metadata read and here. Fail closed rather than forward unauthenticated.
    denied(
      attempt,
      'credential-revoked',
      CREDENTIAL_REFUSAL(request.credential),
      'agentgate_unknown_credential',
    );
  }

  const response = await forward({
    method: request.method,
    url: request.url,
    upstreamBaseUrl: resolved.upstreamBaseUrl,
    headers: request.headers,
    body: request.body,
    injected: applyInjection(resolved.injection, resolved.value),
    requestId: attempt.requestId,
  });

  await recordBytes(deps.prisma, mission.id, (attempt.bodySize ?? 0) + response.responseBytes);

  return {
    status: response.status,
    headers: response.headers,
    body: response.body,
    requestId: attempt.requestId,
    decision: 'ALLOW',
    reason: verdict.reason,
  };
}

/**
 * SPEC D3, steps 1 to 10, in order, with exactly one audit row per attempt.
 *
 * Every refusal travels as an `AgentGateError` so that one place decides what the agent is
 * told and what the trail records — the alternative is a dozen return shapes and a dozen
 * chances for a decision and its audit row to disagree.
 */
export async function handleProxyRequest(
  deps: PipelineDeps,
  requestId: string,
  authorization: string | undefined,
  rawBody: unknown,
): Promise<ProxyOutcome> {
  const attempt: Attempt = { requestId, startedAt: Date.now() };

  let outcome: ProxyOutcome | undefined;
  let decision: AuditDecision = 'ERROR';
  let reason = 'the gateway did not reach a decision';

  try {
    outcome = await execute(deps, attempt, authorization, rawBody);
    decision = outcome.decision;
    reason = outcome.reason;

    return outcome;
  } catch (error) {
    const failure =
      error instanceof AgentGateError
        ? error
        : // A bug or an outage: the agent learns nothing about it beyond the request id.
          new AgentGateError('agentgate_upstream_error', 500, 'the gateway could not answer', {
            cause: error,
          });

    decision = AUDIT_DECISION_BY_CODE[failure.code];
    reason = failure.message;
    outcome = {
      status: failure.httpStatus,
      headers: {},
      body: failure.toBody(requestId),
      requestId,
      decision,
      reason,
    };

    return outcome;
  } finally {
    // Exactly one row per attempt, whatever happened — including the attempts that never got
    // past the token (D12). A failure to write it is not swallowed: an unaudited request is
    // not a request this gateway is willing to have served.
    await deps.audit.record({
      requestId,
      decision,
      reason,
      latencyMs: Date.now() - attempt.startedAt,
      principalId: attempt.principalId ?? null,
      agentId: attempt.agentId ?? null,
      missionId: attempt.missionId ?? null,
      resource: attempt.resource ?? null,
      action: attempt.action ?? null,
      method: attempt.method ?? null,
      destHost: attempt.destHost ?? null,
      destPath: attempt.destPath ?? null,
      matchedPolicy: attempt.matchedPolicy ?? null,
      httpStatus: outcome?.status ?? null,
      bodySize: attempt.bodySize ?? null,
      bodyHash: attempt.bodyHash ?? null,
      contentType: attempt.contentType ?? null,
    });
  }
}
