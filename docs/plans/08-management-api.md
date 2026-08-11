# Sub-plan 08 — Management API + OpenAPI

**Goal:** Admin-facing REST API (bearer `ADMIN_TOKEN`) for principals, agents, missions, credentials, approvals, audit, stats + agent-token minting + OpenAPI document. The web UI (plan 10) and the demo (plan 09) consume only this.

**Depends on:** 06, 07. Extends the management plugin started in 07.

## Files

- Create: `apps/gateway/src/management/{plugin.ts, principals.routes.ts, agents.routes.ts, missions.routes.ts, credentials.routes.ts, audit.routes.ts, stats.routes.ts, openapi.ts}`
- Modify: `apps/gateway/src/index.ts` — register management plugin (separate tree; enforcement never imports it — SPEC D11)
- Tests: integration per route group + credential non-exposure deep scan

## Routes (binding; all under `/api/v1`, zod-validated, errors via `AgentGateError`)

```text
POST   /principals                  {name}
GET    /principals
POST   /agents                      {principalId, agentType}
GET    /agents          GET /agents/:id      (+ activeMission, recent audit summary)
POST   /missions                    {principalId, agentId, intent, permissions, network, limits, expiresAt, environment?}
GET    /missions        GET /missions/:id    (+ usage: requestCount, bytesTotal, from UsageCounter)
POST   /missions/:id/expire                  (demo case 6; sets status=expired)
POST   /missions/:id/tokens                  → {token, expiresAt}  (TokenService.mint, sessionId=ses_xxx; TTL=min(mission.expiresAt, now+60m))
POST   /credentials                 {alias, provider, logicalHost, upstreamBaseUrl, injection, value} → value encrypted, response echoes everything EXCEPT value
GET    /credentials                          → list without values, with {provider, logicalHost, injection.type/name, status}
GET    /approvals?status=&missionId=         (07 routes fold into this plugin)
POST   /approvals/:id/approve | /deny
GET    /audit?agentId=&principalId=&missionId=&resource=&decision=&from=&to=&limit=&cursor=
GET    /decisions/:requestId                 → single audit event, shaped for the runtime-decision view (full PolicyInput snapshot fields)
GET    /stats/overview                       → {activeAgents, activeMissions, requestsToday, allowedToday, deniedToday, pendingApprovals}
```

To power `GET /decisions/:requestId`, plan-06 recorder gains one addition here: audit rows store a `policyInputSnapshot Json?` column (redacted: no headers, no body) — Prisma migration in this plan.

## OpenAPI

`@fastify/swagger` + `@fastify/swagger-ui` at `/api/docs`; schemas derived from the zod route schemas (`fastify-type-provider-zod`). CI test: generated document validates (openapi-types parse) and contains every route above.

## Tests (write first)

- Auth: no/wrong admin token → 401 on every management route (table-driven walk of the route tree).
- Credential non-exposure: create credential then deep-scan (`JSON.stringify`) every management GET response for the plaintext value → zero hits. Also scan the OpenAPI doc.
- Mission create validates zod schemas (bad permissions → 400 `agentgate_validation_error`).
- Token minting: minted token passes `/v1/proxy` happy path; token for mission A rejected when mission A expired.
- `/missions/:id/expire` → subsequent proxy call DENY (case 6 end-to-end).
- Audit filters: seed 3 decisions, filter by decision/mission/time window; cursor pagination stable.
- Stats overview counts match inserted fixtures.

## Tasks

- [ ] 1. Management plugin + admin auth guard + route-walk 401 test. Commit.
- [ ] 2. Principals/agents/missions CRUD TDD. Commit.
- [ ] 3. Token minting + expire endpoints TDD (wire to enforcement e2e). Commit.
- [ ] 4. Credentials routes + non-exposure deep scan. Commit.
- [ ] 5. Audit/decisions/stats routes + `policyInputSnapshot` migration TDD. Commit.
- [ ] 6. OpenAPI generation + validation test. Commit.

## Exit criteria

Whole demo drivable by curl against management + proxy APIs; OpenAPI served; credential value unreachable through any endpoint.
