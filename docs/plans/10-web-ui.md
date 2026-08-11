# Sub-plan 10 — Web UI

**Goal:** Next.js management console: Overview, Agents, Missions, Policies, Credentials, Approvals, Audit + the flagship Runtime Decision view. Pure client of the management API — zero policy logic in React.

**Depends on:** 08. Parallelizable with 09.

**Execution note:** invoke the `frontend-design:frontend-design` skill at execution start. Constraints: light theme only, professional/minimal (Linear/Stripe register), design tokens (no hardcoded colors), tablet/laptop-first, guiding empty states, color-coded decision badges (ALLOW green / DENY red / REQUIRE_APPROVAL amber), collapsible sidebar.

## Files

- Create: `apps/web/` Next.js 15 App Router, `package.json`, `Dockerfile`, `tailwind.config` + tokens
- Create: `apps/web/src/lib/api.ts` — single fetch wrapper; `ADMIN_TOKEN` + `GATEWAY_URL` read server-side only (server components / route handlers); token never shipped to the client bundle
- Create: routes `src/app/{page.tsx, agents/, missions/[id]/, policies/, credentials/, approvals/, audit/, decisions/[requestId]/}`
- Create: shared components `src/components/{DecisionBadge, Sidebar, DataTable, EmptyState, UsageBar, JsonBlock}`
- Modify: `docker-compose.yml` — `web` on service-net, port 3000

## Pages (content = SPEC "Web UI" section)

- **Overview `/`**: 6 stat tiles from `/stats/overview` + recent decisions table (last 20 audit events, decision badges, links to decision view). Polling refresh 5 s.
- **Agents**: list + detail (identity, principal, type, active mission link, session count, recent activity from audit filter).
- **Missions `/missions/[id]`**: intent, parties, resources, three action lists (allowed/approval/denied as distinct chip groups), network rules table, limits with `UsageBar` (requestCount/maxRequests, bytesTotal/maxBytes), expiration countdown, expire button (calls `/expire`, confirm dialog).
- **Policies**: read-only for MVP: renders each mission's permission/network document + which engine is active (builtin/OPA from a `/stats` field); honest empty state explaining policies are mission-scoped in MVP.
- **Credentials**: alias cards — provider, logical host, injection `header: Authorization`, status. NEVER a value; no detail fetch that could contain one.
- **Approvals**: pending queue (agent, principal, mission intent, action, resource, host, requested time, policy reason) with **Approve once** / **Deny** buttons → POST then optimistic refresh; history tab.
- **Audit**: filterable table (agent, principal, mission, resource, decision, time range) with cursor pagination; row click → decision view.
- **Decision view `/decisions/[requestId]`** (flagship): vertical formula layout — MISSION, IDENTITY, RESOURCE, ACTION, DATA, ENVIRONMENT, CURRENT STATE as cards each showing the actual `policyInputSnapshot` slice → arrow → POLICY DECISION card (matchedPolicy + reason) → arrow → big decision badge. Plus request metadata (latency, approvalId link if any).

## Tests

Component tests (vitest + testing-library): DecisionBadge variants; approvals actions call the right endpoints (msw); credentials page renders fixture without any `value` key (fixture trap: API mock includes a poisoned `value` field → UI must not render it). One Playwright smoke (optional, compose-gated): overview loads, navigate to a decision view.

## Tasks

- [ ] 1. Scaffold + design tokens + sidebar layout + api.ts (server-side token test: client bundle grep for ADMIN_TOKEN → 0). Commit.
- [ ] 2. Overview + audit table + decision badges. Commit.
- [ ] 3. Missions + agents pages. Commit.
- [ ] 4. Approvals queue (drives demo case 4 manually). Commit.
- [ ] 5. Credentials + policies pages (poisoned-fixture test). Commit.
- [ ] 6. Runtime decision view. Commit.
- [ ] 7. Dockerfile + compose + smoke. Commit.

## Exit criteria

All nav pages functional against live gateway; demo case 4 approvable from the UI; `ADMIN_TOKEN` absent from client bundle; decision view renders a real request end-to-end.
