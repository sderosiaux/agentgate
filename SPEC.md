# AgentGate — Specification

> **Agents get credentials and network access without ever receiving the actual credentials.**

Open-source project for runtime authorization of AI agents.

Status: spec + refinements. Implementation plans live in `docs/plans/`.

---

## Part 1 — Original product spec

### Product idea

AI agents increasingly execute code and call external systems. Sandboxing solves only one part of the problem. The harder question is:

> What is this specific agent allowed to do, for this specific mission, right now?

AgentGate sits between an AI agent and external systems (GitHub, AWS, Kubernetes, databases, internal APIs, SaaS APIs, MCP servers) and controls each action at runtime.

```text
OBSERVE → DECIDE → ENFORCE
```

Every authorization decision uses this context:

```text
MISSION + IDENTITY + RESOURCE + ACTION + DATA + ENVIRONMENT + CURRENT STATE → DECISION
```

A decision returns one of: `ALLOW`, `DENY`, `REQUIRE_APPROVAL`.

### Core concept

A human delegates work to an agent:

```yaml
principal:
  id: user_stephane
agent:
  id: agent_01
  type: codex
mission:
  id: mission_123
  description: 'Fix GitHub issue #423 in repository acme/payments'
permissions:
  - resource: github:acme/payments
    actions: [repo.read, branch.create, pull_request.create]
restrictions:
  - pull_request.merge
  - repository.delete
  - access: github:acme/production-secrets
expires_in: 60m
```

The agent receives:

- a temporary AgentGate identity token
- the AgentGate gateway URL
- credential aliases (e.g. `github_work`)
- **no actual third-party credentials**

### Credential broker

```text
AI Agent
   | AgentGate identity token + credential alias: github_work
   v
AgentGate Gateway
   | identify agent → identify mission → inspect destination/resource/action → evaluate policy
   +---- DENY
   +---- REQUIRE_APPROVAL
   +---- ALLOW → retrieve real credential → inject into request → External Service
```

The AI agent must never receive the real credential. Credentials are injected only after ALLOW. Never return credentials in: API responses, logs, audit events, errors, UI pages, traces.

### Network policy

The gateway controls outbound HTTP access. Mission-level rules:

```yaml
network:
  allow:
    - host: api.github.com
      path: /repos/acme/payments/*
      methods: [GET]
    - host: api.github.com
      path: /repos/acme/payments/pulls
      methods: [POST]
  deny:
    - host: '*'
```

`GET api.github.com/repos/acme/secret-repository` must fail even when the same GitHub credential could access it.

**Credentials define technical capability. AgentGate policy defines authorized capability. Keep these separate.**

### Agent identity

Do not treat an AI agent as the human who launched it. Model delegated identity:

```text
Human
  ├── Codex agent A
  ├── Claude Code agent B
  └── CI agent C
```

Each agent has its own identity storing: `agent_id, principal_id, agent_type, session_id, mission_id, issued_at, expires_at`. Short-lived signed tokens bind one agent to one mission.

### Missions

A mission represents delegated authority:

```yaml
id: mission_123
principal: stephane
agent: codex_8472
intent: 'Investigate issue #423 and create a pull request'
resources: [github:acme/payments]
allowed_actions: [repo.read, pull_request.read, branch.create, pull_request.create]
approval_required: [pull_request.create]
denied_actions: [pull_request.merge, repository.delete]
expires_at: 2026-08-10T22:00:00Z
limits:
  max_requests: 500
  max_bytes: 50000000
```

Missions expire automatically. Requests for expired missions must fail.

### Policy engine

Evaluates structured context:

```json
{
  "identity": { "principal_id": "user_1", "agent_id": "agent_12", "agent_type": "codex" },
  "mission": { "id": "mission_123", "intent": "Fix issue #423" },
  "resource": { "provider": "github", "repository": "acme/payments" },
  "action": { "type": "pull_request.create", "method": "POST" },
  "network": { "host": "api.github.com", "path": "/repos/acme/payments/pulls" },
  "environment": { "name": "development" },
  "current_state": { "request_count": 42 }
}
```

Returns:

```json
{
  "decision": "REQUIRE_APPROVAL",
  "reason": "Creating a pull request requires human approval.",
  "matched_policy": "github-pr-approval"
}
```

Use OPA if it fits the architecture. Keep the policy API independent from OPA internals; support another engine later.

### Human approvals

When a decision is REQUIRE_APPROVAL, the gateway returns `202 approval_required` and creates an approval record shown in the web UI (agent, principal, mission, requested action, resource, target host, request time, policy reason). Actions: **Approve once** / **Deny**.

After approval, a short-lived approval grant is issued. The agent retries with the approval ID. The grant must match agent + mission + resource + action. One approval never becomes a general permission.

### Audit

Append-only audit log. Each event: `timestamp, principal, agent, mission, resource, action, destination, decision, reason, matched_policy, approval_id, request_id, latency`.

Never record: real credentials, authorization headers, raw request bodies (by default). Allowed metadata: `body_size, body_hash, content_type`.

Audit UI with filters: agent, principal, mission, resource, decision, time.

### Usage limits

Per mission: max request count, max transferred bytes, expiration, requests per minute. Enforced by the gateway; usage shown on the mission page.

### Demo architecture

Monorepo. Stack: TypeScript, pnpm, Next.js, Fastify, PostgreSQL, Prisma, OPA, Docker Compose.

```text
/
  apps/ (web, gateway, demo-agent)
  packages/ (auth, policy, shared, sdk)
  services/ (mock-github)
  policies/ (agentgate.rego)
  prisma/
  docker-compose.yml
  Makefile
  README.md
```

### Network isolation demo

Separate Docker networks. The demo agent container has **no direct external network access** — only AgentGate. AgentGate reaches destination services.

```text
        internal network                    external network
Demo Agent ────────── AgentGate Gateway ────────── Mock GitHub API
```

Real deployments require sandbox/network controls forcing agent traffic through AgentGate.

### Mock GitHub service

Requires `Authorization: Bearer super-secret-github-token` (the agent never knows it). Endpoints:

```text
GET    /repos/acme/payments
GET    /repos/acme/payments/issues/423
POST   /repos/acme/payments/pulls
GET    /repos/acme/secret-project
DELETE /repos/acme/payments
```

### Demo scenario (`make demo`)

| Case                  | Request                               | Expected                                                  |
| --------------------- | ------------------------------------- | --------------------------------------------------------- |
| 1. Allowed read       | `GET /repos/acme/payments/issues/423` | ALLOW, credential injected, request succeeds, audit event |
| 2. Secret protection  | Agent inspects its environment        | Only sees alias `github_work`, never the real token       |
| 3. Unauthorized repo  | `GET /repos/acme/secret-project`      | DENY (credential could access it; policy blocks it)       |
| 4. Approval           | `POST /repos/acme/payments/pulls`     | 202 REQUIRE_APPROVAL → approve in UI/API → retry succeeds |
| 5. Dangerous action   | `DELETE /repos/acme/payments`         | DENY, no credential injected                              |
| 6. Mission expiration | Expire mission, repeat case 1         | DENY                                                      |

### Web UI

Clean technical interface (not marketing). Navigation: Overview, Agents, Missions, Policies, Credentials, Approvals, Audit.

- **Overview**: active agents/missions, requests today, allowed/denied, pending approvals, recent decisions.
- **Agent page**: identity, principal, type, active mission, session, expiration, recent activity.
- **Mission page**: intent, agent, principal, resources, allowed/denied/approval actions, network access, limits, usage, expiration.
- **Credentials page**: aliases only, never values (provider, target, injection method, status).
- **Runtime decision view** (flagship screen): visual decision formula — MISSION + IDENTITY + RESOURCE + ACTION + DATA + ENVIRONMENT + CURRENT STATE → POLICY DECISION → ALLOW | DENY | REQUIRE APPROVAL — with the actual data behind each decision.

### Product architecture

```text
AGENT APPLICATIONS (Codex | Claude | CI | Custom)
        ↓
AGENT CONTROL PLANE (identity, delegation, mission, policy, credentials, network rules, approvals, audit, limits)
        ↓
ENFORCEMENT (HTTP/API gateway)
        ↓
GitHub APIs | MCP tools | Data systems
```

Sandbox runtimes (Docker sandboxes, E2B, Daytona, Kubernetes, VMs) sit **below** this layer. AgentGate does not compete with the sandbox — AgentGate decides what leaves the sandbox.

### Security model

`THREAT_MODEL.md` covers at least: agent reads real credentials, agent tries another repository/host/HTTP method, approval reuse, expired mission token reuse, secret-like content through allowed endpoints, gateway bypass, gateway logs credentials, database secret encryption, gateway process compromise. State which risks the prototype handles vs which require deployment-level controls.

### Secret storage

AES-GCM encryption with a master key from the gateway environment. No hardcoded real secrets; demo mock-GitHub secret initialized automatically. Encryption behind an interface designed for future backends (AWS Secrets Manager, Vault, GCP Secret Manager, 1Password) — not implemented now.

### API

Documented REST APIs for: agents, missions, policies, credentials, approvals, audit events, runtime decisions. OpenAPI document. Stable resource IDs. Machine-readable errors:

```json
{
  "error": "agentgate_access_denied",
  "decision": "DENY",
  "reason": "Repository is outside the mission scope.",
  "request_id": "req_123"
}
```

### SDK

```typescript
const agentgate = new AgentGate({
  gatewayUrl: process.env.AGENTGATE_URL,
  token: process.env.AGENTGATE_TOKEN,
});

const response = await agentgate.request({
  credential: 'github_work',
  method: 'GET',
  url: 'https://api.github.com/repos/acme/payments/issues/423',
});
```

The SDK never requires the GitHub credential.

### Tests

Unit + integration, at minimum: valid/invalid/expired agent token, valid/expired mission, allowed/denied resource, allowed/denied host, allowed/denied HTTP method, credential injection, credential redaction, approval request, approval grant, approval reuse failure, request limit, byte limit, audit creation.

One security test greps all logs for `super-secret-github-token` and **fails if found**.

### Developer experience

```bash
git clone ... && cd agentgate
cp .env.example .env
docker compose up --build
```

Plus: `make setup, make dev, make test, make demo, make reset`. Seed data — working environment without manual database setup.

### README

Must open with the tagline, then:

```text
Sandboxing answers: "Where can this agent execute?"
AgentGate answers:  "What can this agent do?"
```

Explain OBSERVE → DECIDE → ENFORCE, the authorization context formula, the full demo flow, Mermaid architecture diagram.

### Architecture rules

- Enforcement path separate from management UI. No policy decisions in React code.
- Agent can never query credential values; APIs never expose them.
- Do not trust user-provided resource classification — parse requests on the gateway.
- Audit code independent from policy code.
- Provider-specific logic behind adapters. Future adapters: GitHub, AWS, Kubernetes, PostgreSQL, Kafka, MCP, generic HTTP. Implement only what the MVP requires.

### Product direction

Not another sandbox product. `AI Agent → Sandbox → AgentGate → External world`. The first working version must prove one thing extremely well:

> An AI agent can perform useful authenticated work against an external service without possessing that service's credential, while AgentGate makes a runtime authorization decision for every action.

---

## Part 2 — Refinements and decisions

Ambiguities found in Part 1, resolved here. These decisions are binding for the implementation plans.

### D1. Proxy style: structured proxy endpoint, not transparent proxy

The gateway exposes `POST /v1/proxy` taking `{credential, method, url, headers?, body?}` (matches the SDK). A transparent forward-proxy (CONNECT / TLS MITM) is future work — it adds certificate complexity without strengthening the MVP proof. TRADEOFF: agents must use the SDK or the endpoint shape; acceptable, and it keeps request parsing trivial and reliable.

### D2. Logical host vs physical upstream

Policies and agents reference the **logical host** (`api.github.com`). Each credential record carries `logicalHost` and `upstreamBaseUrl`. In the demo, `github_work` maps `api.github.com → http://mock-github:3001` via seed/env. Policy matching always uses the logical host; only the forwarder resolves the physical upstream. This removes the spec's implicit conflict between "network rules say api.github.com" and "demo talks to mock-github".

### D3. Decision precedence (spec contradiction fix)

Part 1's mission example lists `pull_request.create` in both `allowed_actions` and `approval_required`. Precedence, strict order:

```text
1. invalid/expired token            → DENY (401)
2. mission missing/expired/revoked  → DENY
3. limits exceeded                  → DENY
4. network deny rule match          → DENY
5. no network allow rule match      → DENY (default deny)
6. unmapped action (unknown route)  → DENY
7. denied_actions match             → DENY
8. approval_required match          → REQUIRE_APPROVAL (unless valid grant attached → ALLOW)
9. allowed_actions match            → ALLOW
10. otherwise                       → DENY (default deny)
```

So `approval_required` ⊂ `allowed_actions` is the normal shape: the action is in-scope but gated.

### D4. Resource/action mapping is gateway-owned

A GitHub adapter maps `(method, normalized path)` → `(resource, action)`:

| Method + path                        | Resource         | Action                |
| ------------------------------------ | ---------------- | --------------------- |
| `GET /repos/{o}/{r}`                 | `github:{o}/{r}` | `repo.read`           |
| `GET /repos/{o}/{r}/issues/{n}`      | `github:{o}/{r}` | `issue.read`          |
| `GET /repos/{o}/{r}/pulls`           | `github:{o}/{r}` | `pull_request.read`   |
| `POST /repos/{o}/{r}/pulls`          | `github:{o}/{r}` | `pull_request.create` |
| `POST /repos/{o}/{r}/git/refs`       | `github:{o}/{r}` | `branch.create`       |
| `PUT /repos/{o}/{r}/pulls/{n}/merge` | `github:{o}/{r}` | `pull_request.merge`  |
| `DELETE /repos/{o}/{r}`              | `github:{o}/{r}` | `repository.delete`   |

Unknown route → DENY with `reason: unmapped_action` (never trust agent-provided classification; never fall back to a generic allow). Adapter interface is provider-pluggable (`ProviderAdapter`), GitHub is the only MVP implementation.

Mission grants like `repo.read` also authorize `issue.read` via a small action-hierarchy map (`repo.read ⊇ issue.read, pull_request.read`), kept explicit in code — no wildcard magic.

### D5. Policy engine: built-in evaluator default, OPA optional

`PolicyEngine` interface: `evaluate(input: PolicyInput): Promise<PolicyDecision>`. Two implementations:

- `BuiltinPolicyEngine` (default) — deterministic TypeScript applying D3 over the mission document. Fully unit-testable, no extra container.
- `OpaPolicyEngine` — posts the same `PolicyInput` to OPA evaluating `policies/agentgate.rego` (same D3 semantics). Selected with `POLICY_ENGINE=opa`; OPA container present in compose but optional for the demo.

Rationale: OPA-only would make the core decision path depend on a sidecar for the MVP proof. The rego file exists and is CI-tested for parity on the demo cases, proving the "another engine later" requirement.

### D6. URL normalization before matching

Before any policy/network matching: parse with `new URL()`, reject non-http(s), decode path, collapse `.`/`..` segments (reject if escaping root), strip query from path matching, lowercase host, reject `@userinfo` and embedded credentials in URLs. Matching semantics: host — exact or `*.suffix` glob; path — `*` matches within one segment, `**` matches across segments; explicit deny > allow; no rule → deny.

### D7. Approval grants: single-use, short TTL, atomically consumed

Approval record: `pending → approved | denied | expired | consumed`. Grant TTL 5 minutes from approval. Retry carries `approvalId` in the proxy request body. Consumption is a single conditional `UPDATE ... WHERE status='approved'` (atomic; a second concurrent use loses the race and is denied — this is the approval-reuse test). Grant matches on `(agentId, missionId, resource, action)` — not on exact body, flagged in THREAT_MODEL.md as a prototype limitation (an approved `pull_request.create` doesn't pin the PR title/branch).

### D8. Limits accounting

Counters per mission in Postgres, atomic `UPDATE ... SET n = n + 1 RETURNING`, checked pre-forward. `max_bytes` counts request body + response body sizes. `requests per minute` = fixed one-minute window (per-mission row keyed by minute) — coarse but honest; Redis sliding window noted as production follow-up. Denied requests still count toward `max_requests` (prevents probe spam), documented.

### D9. Tokens

JWT signed Ed25519 (`jose` lib), gateway-held keypair, claims: `sub=agent_id, principal_id, agent_type, mission_id, session_id, iat, exp`. TTL from mission `expires_at` capped at 60 min. No refresh in MVP; a new token is minted from the control-plane API. One token ↔ one mission (enforced by claim + mission lookup).

### D10. "DATA" in the decision context

MVP interpretation: request metadata only — `content_type`, `body_size`, `body_hash` (sha256). No content inspection/DLP in MVP; the `PolicyInput.data` field exists so a future DLP stage slots in without API change. THREAT_MODEL.md lists "secret-like content through allowed endpoints" as not mitigated in the prototype.

### D11. Gateway = one Fastify app, two isolated plugin trees

`apps/gateway` hosts both the enforcement routes (`/v1/token`… no — token minting is management; enforcement is `/v1/proxy` + `/v1/approvals/:id` read) and the management API (`/api/v1/*` CRUD + OpenAPI). They are separate Fastify plugins with separate dependency wiring; enforcement never imports management modules. Splitting into two processes is a compose-level change later, not a refactor. The Next.js web app is a pure client of the management API — zero policy logic in React.

### D12. Audit guarantees

Append-only enforced by: no update/delete code paths + Postgres `REVOKE UPDATE, DELETE` on `audit_events` for the app role, via a Prisma migration with raw SQL. Every proxy attempt writes exactly one event, including auth failures (with whatever identity is known). A dedicated `redact()` serializer strips `authorization`, `x-agentgate-*` secrets, and any value matching registered credential material before any log/audit write. Hash-chaining audit rows: out of scope, listed in THREAT_MODEL.md.

### D13. Secret storage

`SecretStore` interface (`getByAlias(alias): Promise<{value, injection}>`), single MVP impl `DbSecretStore` using AES-256-GCM (`node:crypto`), key from `AGENTGATE_MASTER_KEY` (32-byte base64), random 12-byte IV per secret, ciphertext+tag+iv stored. Master key absent → gateway refuses to boot. Injection descriptor per credential: `{type: "header", name: "Authorization", format: "Bearer {value}"}`.

### D14. Demo mechanics

- Case 4 approval: `make demo` runs interactively — prints the approval URL and polls; `DEMO_AUTO_APPROVE=1` (default in CI/`make demo`) approves via management API after 2 s so the demo is unattended.
- Case 6: admin endpoint `POST /api/v1/missions/:id/expire` force-expires.
- Case 2: demo-agent dumps its full env and greps itself for `super-secret` — must find nothing.
- Network isolation: compose networks `agent-net` (`internal: true`: demo-agent + gateway) and `service-net` (gateway + mock-github + postgres + web). Demo prints a failed direct `curl http://mock-github:3001` from the agent container as proof.

### D15. Repo layout delta

Part 1 layout kept, with `packages/sdk` added (the spec requires an SDK but omitted it from the tree) and `prisma/` living inside `apps/gateway` (Prisma client is gateway-owned; web never touches the DB).

### Non-goals (MVP)

Transparent HTTPS proxy, DLP/content inspection, multi-tenant auth on the management API (single admin token), external secret backends, OPA bundle distribution, hash-chained audit, Redis rate limiting, real GitHub adapter against api.github.com.
