# Sub-plan 05 — Policy engine

**Goal:** `packages/policy`: pure, exhaustively tested decision logic — URL normalization, network rule matching, GitHub adapter (request→resource/action), builtin engine implementing SPEC D3 precedence, OPA engine with parity tests.

**Depends on:** 02. Parallelizable with 03, 04. No Prisma/Fastify imports — pure package.

## Files

- Create: `packages/policy/src/{types.ts, url.ts, network.ts, actions.ts, engine.ts, opa.ts, index.ts}`
- Create: `packages/policy/src/adapters/{types.ts, github.ts}`
- Create: `policies/agentgate.rego`, `policies/agentgate_test.rego`
- Tests per module

## Key interfaces (binding)

```typescript
// types.ts — the engine-agnostic contract (SPEC "Policy engine" input/output)
export interface PolicyInput {
  identity: { principalId: string; agentId: string; agentType: string };
  mission: {
    id: string; intent: string;
    permissions: MissionPermissions;   // from @agentgate/shared
    network: NetworkRules;
    expiresAt: string;                 // ISO
  };
  resource: { provider: string; id: string };          // id: "acme/payments"
  action: { type: string; method: string };            // "pull_request.create", "POST"
  network: { host: string; path: string };             // normalized logical host/path
  environment: { name: string };
  currentState: { requestCount: number; bytesTotal: number };
  data: { contentType?: string; bodySize?: number; bodyHash?: string };
}
export interface PolicyEngine {
  evaluate(input: PolicyInput): Promise<PolicyDecision>; // PolicyDecision from shared
}

// url.ts
export interface NormalizedUrl { host: string; path: string; protocol: "http:"|"https:" }
export function normalizeUrl(raw: string): NormalizedUrl; // throws AgentGateError(validation) on: non-http(s), userinfo, path escaping root after ..-collapse; decodes %-encoding once; lowercases host; strips query/fragment

// network.ts
export function matchNetworkRules(rules: NetworkRules, req: {host: string; path: string; method: string}):
  { matched: "deny" } | { matched: "allow" } | { matched: "none" };
// host: exact or "*.suffix" or "*"; path: "*" one segment, "**" any depth, absent = any; deny checked first

// adapters/types.ts
export interface ProviderAdapter {
  provider: string;                                     // "github"
  matchesHost(logicalHost: string): boolean;
  mapRequest(method: string, path: string): { resource: string; action: string } | null; // null = unmapped
}
// adapters/github.ts — table from SPEC D4, resource = `github:{owner}/{repo}`

// actions.ts — grant implication, explicit map (SPEC D4)
export function actionImplied(granted: string, requested: string): boolean;
// repo.read ⊇ issue.read, pull_request.read; otherwise strict equality

// engine.ts
export function createBuiltinEngine(): PolicyEngine;    // D3 steps 6–10 (steps 1–5 are gateway pipeline)
// matchedPolicy values: "mission-denied-action" | "mission-approval-required" | "mission-allowed-action" | "mission-default-deny" | "mission-resource-scope"

// opa.ts
export function createOpaEngine(opaUrl: string): PolicyEngine; // POST {input} to /v1/data/agentgate/decision
```

Engine also checks resource scope: `input.resource` must be in `permissions.resources` (else DENY `mission-resource-scope`) — an allowed action on an out-of-scope repo is still denied.

## Rego

`agentgate.rego` reimplements exactly engine.ts semantics over the same `PolicyInput`. `opa test policies/` in CI when `opa` binary present. Parity: run the full builtin test matrix through `createOpaEngine` gated by `process.env.OPA_URL` (compose `opa` service on service-net, `opa run --server` with policies volume-mounted).

## Tests (write first — this package gets the densest matrix)

- url: happy path; `..` traversal rejected; `%2e%2e` rejected after decode; `//` collapse; userinfo rejected; `ftp://` rejected; query stripped; host lowercased.
- network: deny-wins over allow; `*` host; `*.github.com` matches `api.github.com` not `github.com`; `/repos/acme/payments/**` matches deep paths but not `/repos/acme/payments2/x`; `*` single-segment does NOT cross `/`; method filter; empty rules → none.
- github adapter: full D4 table both directions; unknown path → null; `GET /repos/a/b/../c` never reaches adapter unnormalized (adapter asserts no `..`).
- actions: implication map; unknown action strict.
- engine precedence matrix (table-driven, ≥15 cases): denied beats approval beats allowed; approval∈allowed → REQUIRE_APPROVAL; unlisted action → default deny; out-of-scope resource → deny even for allowed action; reasons/matchedPolicy asserted.
- opa parity: same table, skipIf no OPA_URL.

## Tasks

- [ ] 1. Package scaffold + `types.ts`. Commit.
- [ ] 2. `url.ts` TDD. Commit.
- [ ] 3. `network.ts` TDD. Commit.
- [ ] 4. `adapters/github.ts` + `actions.ts` TDD. Commit.
- [ ] 5. `engine.ts` TDD (precedence matrix). Commit.
- [ ] 6. `agentgate.rego` + rego tests + `opa.ts` + parity suite + compose `opa` service. Commit.

## Exit criteria

Pure package, zero runtime deps beyond zod/shared; precedence matrix green on builtin; parity green with OPA up; rego tests pass under `opa test`.
