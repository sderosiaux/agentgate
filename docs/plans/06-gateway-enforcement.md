# Sub-plan 06 — Gateway enforcement path

**Goal:** `POST /v1/proxy` full pipeline: authn → mission → limits → normalize → network policy → adapter mapping → policy engine → credential injection → forward → audit. The core of the product.

**Depends on:** 02, 03, 04, 05. Approvals (step 8 of D3) stubbed here as plain REQUIRE_APPROVAL → 202 without record; plan 07 completes it.

## Files

- Create: `apps/gateway/src/enforcement/{proxy.route.ts, pipeline.ts, forwarder.ts, limits.ts}`
- Create: `apps/gateway/src/audit/recorder.ts` (independent from policy code — SPEC architecture rule)
- Create: `apps/gateway/src/logging.ts` (pino instance with redaction)
- Modify: `apps/gateway/src/index.ts` — register enforcement plugin, wire deps
- Tests: unit (limits, forwarder header build) + integration (full pipeline against in-process mock-github + test Postgres)

## Request/response contract (binding — matches SDK, SPEC D1)

```typescript
// POST /v1/proxy  (agent-facing; auth: Authorization: Bearer <agent JWT>)
interface ProxyRequestBody {
  credential: string;               // alias, e.g. "github_work"
  method: string;
  url: string;                      // logical URL: https://api.github.com/...
  headers?: Record<string, string>; // forwarded minus hop-by-hop + authorization (agent's authorization NEVER forwarded)
  body?: string;                    // utf-8; base64 support out of scope MVP
  approvalId?: string;              // plan 07
}
// 200/2xx: upstream response passthrough: {status, headers (safelist), body}
// 401 invalid token → AgentGateError body
// 403 DENY        → {error:"agentgate_access_denied", decision:"DENY", reason, request_id}
// 202 approval    → {error:"agentgate_approval_required", decision:"REQUIRE_APPROVAL", reason, approval_id, request_id}
// 429 limits      → {error:"agentgate_limit_exceeded", ...}
```

## Pipeline (binding order = SPEC D3 steps 1–10)

```typescript
// pipeline.ts
export interface PipelineDeps {
  tokenService: TokenService; prisma: PrismaClient; secretStore: SecretStore;
  engine: PolicyEngine; adapters: ProviderAdapter[]; audit: AuditRecorder; clock: () => Date;
}
export async function handleProxyRequest(deps: PipelineDeps, rawAuthHeader: string|undefined, body: ProxyRequestBody): Promise<ProxyOutcome>;
```

1. verify JWT → claims; 2. load mission by `claims.missionId`, check status+`expiresAt` vs `clock()` (also mark row expired lazily); 3. limits (below); 4. `normalizeUrl(body.url)`; 5. credential lookup by alias → check `logicalHost === normalized.host` (mismatch → DENY `agentgate_unknown_credential`); 6. `matchNetworkRules` (deny/none → DENY); 7. adapter `mapRequest` (null → DENY unmapped); 8. build `PolicyInput`, `engine.evaluate`; 9. on ALLOW: `secretStore` value → injection header → `forwarder` to `upstreamBaseUrl + path` (undici, 10 s timeout, `x-request-id` set); 10. **always** exactly one `audit.record()` in a `finally` — including thrown errors (decision `ERROR`).

## Limits (`limits.ts`, SPEC D8)

```typescript
export async function consumeRequestSlot(prisma, missionId, limits): Promise<{ok: true} | {ok: false; reason: "max_requests"|"rpm"}>;
// atomic: INSERT..ON CONFLICT UPDATE RETURNING on UsageCounter + RateWindow(minute=date_trunc)
export async function recordBytes(prisma, missionId, n): Promise<void>;
export function bytesExceeded(counter, limits): boolean; // checked pre-forward with request size; response bytes recorded post-forward
```

## Redaction (`logging.ts`)

pino redact paths: `req.headers.authorization`, `*.headers.authorization`, `*.value`, `*.token`, `*.secret`. Additionally `registerSensitive(value)` called by SecretStore on every decrypt → a serializer replaces any registered substring with `[REDACTED]` in every log line. Forwarder logs upstream host + status only, never headers.

## Integration tests (write first; testcontainer or compose Postgres, mock-github via `buildMockGithub` on ephemeral port with `upstreamBaseUrl` pointed at it)

From SPEC test list: valid token allowed read → 200 + upstream body + audit ALLOW row; invalid signature → 401 + audit ERROR; expired token → 401; expired mission → DENY `agentgate_mission_expired`; out-of-scope repo (`secret-project`) → 403 + audit DENY + **mock-github access log shows no request**; denied method DELETE → 403; host not in rules → 403; unmapped route → 403 unmapped_action; credential injected (mock receives correct bearer; agent request carrying its own `Authorization` toward upstream is stripped); response passthrough preserves status/body; `max_requests=2` → third call 429; rpm window; byte limit; audit row per attempt incl. 401s; **no response/log/audit contains the mock token** (grep captured logs in-test).

## Tasks

- [ ] 1. `logging.ts` + redaction TDD (registered substring scrubbed). Commit.
- [ ] 2. `limits.ts` TDD (concurrency: 10 parallel consumes, exactly `maxRequests` succeed). Commit.
- [ ] 3. `audit/recorder.ts` TDD (writes full row; refuses keys named authorization/value). Commit.
- [ ] 4. `forwarder.ts` TDD (header build: injection format, hop-by-hop strip, agent auth strip). Commit.
- [ ] 5. `pipeline.ts` happy path integration (case: allowed read end-to-end). Commit.
- [ ] 6. Deny matrix integration tests (each step's failure mode). Commit.
- [ ] 7. Limits + audit integration, log-capture secret grep. Commit.
- [ ] 8. Register route in gateway app; compose smoke: agent-net curl → gateway → mock-github works. Commit.

## Exit criteria

Full matrix green; demo cases 1, 3, 5 reproducible by hand with curl + minted token (mint manually via script until plan 08); zero secret occurrences in captured logs.
