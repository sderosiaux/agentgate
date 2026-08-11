# Sub-plan 09 — SDK, demo agent, network isolation, `make demo`

**Goal:** TypeScript SDK, a demo agent running the 6 SPEC cases inside a network-isolated container, and an unattended `make demo` that proves the whole product.

**Depends on:** 08. Parallelizable with 10.

## Files

- Create: `packages/sdk/src/{client.ts, errors.ts, index.ts}`, tests (against in-process gateway)
- Create: `apps/demo-agent/src/{main.ts, cases.ts, report.ts}`, `Dockerfile`
- Modify: `docker-compose.yml` — `demo-agent` on `agent-net` ONLY; profile `demo` (not started by default)
- Modify: `Makefile` — `demo` target
- Create: `scripts/demo-orchestrator.mjs` (host-side: seeds, mints token, injects env, runs demo-agent container, auto-approves if `DEMO_AUTO_APPROVE=1`, collects output)

## SDK (binding — SPEC "SDK" section)

```typescript
export class AgentGate {
  constructor(opts: { gatewayUrl: string; token: string });
  request(req: {
    credential: string;
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
    approvalId?: string;
  }): Promise<{ status: number; headers: Record<string, string>; body: string; json<T>(): T }>;
  // 202 → throws ApprovalRequiredError {approvalId, reason, requestId}
  // 403 → throws AccessDeniedError {reason, requestId}
  // 429 → throws LimitExceededError; 401 → throws InvalidTokenError
  getApproval(
    approvalId: string,
  ): Promise<{ status: 'pending' | 'approved' | 'denied' | 'expired' | 'consumed' }>;
  waitForApproval(
    approvalId: string,
    opts?: { timeoutMs?: number; intervalMs?: number },
  ): Promise<void>; // polls, throws on denied/timeout
}
```

No GitHub credential anywhere in the SDK surface. SDK tests: each error mapping; retry-with-approval flow; headers passthrough.

## Demo agent (`cases.ts` — each case returns `{name, pass, evidence}`)

1. **Allowed read**: `GET https://api.github.com/repos/acme/payments/issues/423` → expect 200 + issue title printed.
2. **Secret protection**: dump `process.env` sorted; assert no value contains `super-secret`; print the only credential-ish thing it has: `credential alias: github_work`. Then `grep`-scan its own filesystem `/app` for the token → 0 hits.
3. **Unauthorized repo**: `GET .../repos/acme/secret-project` → expect AccessDeniedError, print reason.
4. **Approval**: `POST .../repos/acme/payments/pulls` (title from case-1 issue) → ApprovalRequiredError → print approval URL → `waitForApproval` (orchestrator auto-approves after 2 s when `DEMO_AUTO_APPROVE=1`) → retry with `approvalId` → expect 201, print PR number. Bonus: retry again with same approvalId → expect AccessDeniedError (reuse blocked) — printed as part of the case.
5. **Dangerous action**: `DELETE .../repos/acme/payments` → AccessDeniedError.
6. **Mission expiration**: agent signals orchestrator (writes to stdout marker; orchestrator calls `/missions/:id/expire`), then repeats case-1 request → expect mission-expired denial.
7. **Network isolation proof** (runs first): raw `fetch("http://mock-github:3001/repos/acme/payments")` → must FAIL (DNS/timeout ≤3 s); direct internet `fetch("https://example.com")` → must FAIL. Prints both.

`main.ts`: runs 0→6 sequentially, prints a final table, exit code 0 only if all pass. Env: `AGENTGATE_URL`, `AGENTGATE_TOKEN` (injected by orchestrator via `docker compose run -e`).

## `make demo`

`demo-orchestrator.mjs`: compose up -d (postgres, gateway, mock-github) → wait healthy → seed → create fresh mission + mint token via management API → `docker compose run --rm -e ... demo-agent` streaming output → watch for case-4 marker to auto-approve and case-6 marker to expire → propagate exit code. Idempotent across runs (fresh mission each time).

## Tests

SDK unit/integration suite; demo-agent `cases.ts` unit-tested with a stubbed SDK (each case's pass/fail logic); the real end-to-end IS `make demo` — wired into CI as `make demo` after `docker compose build`.

## Tasks

- [ ] 1. SDK TDD against in-process gateway app. Commit.
- [ ] 2. `cases.ts` with stub-SDK tests. Commit.
- [ ] 3. demo-agent Dockerfile + compose entry (agent-net only, profile demo). Commit.
- [ ] 4. Orchestrator script + Makefile target. Run `make demo` for real; fix until all 7 checks pass. Commit.

## Exit criteria

`make demo` from a clean clone (`make reset` first) passes cases 0–6 unattended, exit 0, and prints human-readable evidence per case.
