# Sub-plan 07 — Human approvals

**Goal:** REQUIRE_APPROVAL creates a pending approval record; humans approve/deny; agent retries with `approvalId`; grants are single-use, short-TTL, bound to (agent, mission, resource, action).

**Depends on:** 06.

## Files

- Create: `apps/gateway/src/approvals/{service.ts, agent.routes.ts}` (enforcement side: `GET /v1/approvals/:id` — status subset, requires agent JWT, only own-mission approvals)
- Create: `apps/gateway/src/management/approvals.routes.ts` (admin bearer `ADMIN_TOKEN`: `GET /api/v1/approvals?status=`, `POST /api/v1/approvals/:id/approve`, `POST /api/v1/approvals/:id/deny`) — first management plugin; plan 08 extends the tree
- Modify: `apps/gateway/src/enforcement/pipeline.ts` — step 8 completed: create record on REQUIRE_APPROVAL; consume grant on retry
- Tests: integration on full flow

## Service (binding)

```typescript
export interface ApprovalService {
  createPending(input: { missionId; agentId; resource; action; reason;
    requestSummary: {method; host; path; bodySize?; contentType?} }): Promise<{approvalId: string}>;
  approve(id: string, decidedBy: string): Promise<void>;   // pending→approved, grantExpiresAt = now+5min
  deny(id: string, decidedBy: string): Promise<void>;      // pending→denied
  // Atomic single-use consumption (SPEC D7): UPDATE approvals SET status='consumed', consumed_at=now()
  //   WHERE id=$1 AND status='approved' AND grant_expires_at > now()
  //   AND mission_id=$2 AND agent_id=$3 AND resource=$4 AND action=$5  RETURNING id
  tryConsume(id: string, bind: {missionId; agentId; resource; action}): Promise<
    "consumed" | "not_found" | "not_approved" | "expired" | "mismatch">;
}
```

Pipeline change: after `engine.evaluate` returns REQUIRE_APPROVAL — if `body.approvalId` present, `tryConsume`; `"consumed"` → proceed as ALLOW (audit records `approvalId`, decision ALLOW, matchedPolicy `approval-grant`); any other result → 202 with a **new** pending approval? No — mismatch/expired/reuse → 403 `agentgate_access_denied` with the precise reason; only absence of `approvalId` creates a new pending record and returns 202 with its id (re-POST without approvalId while one is pending for same (mission, resource, action) returns the existing pending id — idempotent, no spam).

## Tests (write first, integration)

- POST pulls → 202 + `approval_id`; approval row pending with request summary; repeat POST → same id.
- Approve via admin route → agent `GET /v1/approvals/:id` shows approved; retry with approvalId → 200, mock receives request, audit ALLOW with approvalId.
- **Reuse**: second retry same approvalId → 403; audit DENY reason approval already consumed.
- Race: two parallel retries with same id → exactly one 200 (assert mock-github hit exactly once).
- Mismatch: approval for `pull_request.create` used on `DELETE /repos/acme/payments` → 403 (and the deny path still wins earlier anyway — assert reason is denied action, approval untouched).
- Expiry: approve, advance `clock` past 5 min (clock injected) → 403.
- Deny: denied approval retry → 403; agent status endpoint shows denied.
- Agent isolation: agent JWT of another mission cannot read the approval (404).

## Tasks

- [ ] 1. `service.ts` TDD (state machine + atomic consume incl. race test). Commit.
- [ ] 2. Pipeline integration (202 flow + idempotent pending). Commit.
- [ ] 3. Admin routes plugin + bearer guard TDD. Commit.
- [ ] 4. Agent status route TDD (scoping). Commit.
- [ ] 5. End-to-end approve-retry-reuse suite. Commit.

## Exit criteria

Demo case 4 executable via curl (202 → admin approve → retry 201 → reuse 403). One approval never becomes a general permission (mismatch tests green).
