# Sub-plan 11 — Hardening, threat model, README, final verification

**Goal:** THREAT_MODEL.md, the cross-cutting secret-leak test, README, and the final full-system verification loop.

**Depends on:** 09, 10.

## Files

- Create: `THREAT_MODEL.md`, `README.md`, `tests/security/secret-leak.test.ts` (root-level `tests/` workspace), `scripts/leak-scan.mjs`
- Modify: `Makefile` — `test` includes leak scan; CI workflow `.github/workflows/ci.yml` (typecheck, unit, compose build, `make demo`, leak scan)

## Secret-leak test (SPEC "Tests" — the one that greps for `super-secret-github-token`)

`scripts/leak-scan.mjs`, run AFTER a full `make demo`:

1. `docker compose logs --no-color` (all services) → grep token → must be found ONLY in `mock-github` env echo? No — must be found **nowhere** except… nowhere: mock-github must not log its own token either (it logs auth failures without the header). Zero tolerance.
2. `SELECT * FROM audit-related tables` dumped as JSON → grep → zero.
3. Demo-agent captured stdout (orchestrator saves to `artifacts/demo-output.txt`) → grep → zero.
4. Gateway API sweep: fetch every management GET endpoint + OpenAPI doc → grep → zero.
5. Web check: `curl` each web page HTML → grep → zero.

Any hit → exit 1 with location. Vitest wrapper asserts exit 0 so it shows in `make test` (compose-gated: skips with loud warning if stack not up).

## THREAT_MODEL.md (binding structure)

Table per SPEC threat + status ∈ {✅ mitigated in prototype, ⚠️ partially, ❌ deployment-level control required}:

| Threat | Status | Mechanism / required control |
|---|---|---|
| Agent reads real credentials | ✅ | Broker: secrets only decrypt post-ALLOW in gateway memory; never in responses/env of agent |
| Agent tries another repository | ✅ | Resource scope + network path rules (D3 step 5–7) |
| Agent tries another host | ✅ | Logical-host binding on credential + network rules |
| Agent changes HTTP method | ✅ | Method in network rules + action mapping |
| Agent reuses an approval | ✅ | Atomic single-use consume (D7) |
| Agent reuses expired mission token | ✅ | JWT exp + mission status re-check per request |
| Secret-like content through allowed endpoints | ❌ | No DLP in MVP (D10); `data` field reserved; needs content inspection |
| Agent bypasses the gateway | ⚠️ demo / ❌ prod | Demo: internal Docker network; prod: egress firewall/netpol forcing traffic through gateway |
| Gateway logs credentials | ✅ | Redacting serializer + registered-substring scrub + leak-scan test |
| Database contains encrypted secrets | ✅ | AES-256-GCM, master key env-only; ❌ key rotation not implemented |
| Gateway process compromise | ❌ | Out of scope: gateway holds master key + secrets in memory; needs HSM/KMS + isolation in prod |
| Approval doesn't pin request body | ⚠️ | Grant binds (agent, mission, resource, action), not payload (D7) |

Plus a "deployment requirements" section (force egress through gateway, protect ADMIN_TOKEN, generate fresh keys, TLS in front).

## README (invoke `humanizer` skill when writing)

Order: tagline blockquote → sandbox vs AgentGate contrast → OBSERVE/DECIDE/ENFORCE → decision-context formula → Mermaid architecture diagram (SPEC "Product architecture") → quickstart (clone, cp .env.example, compose up, make demo) → demo walkthrough with real captured output per case → API/OpenAPI pointer → SDK snippet → repo layout → threat model pointer → non-goals & roadmap (adapters: AWS, K8s, Postgres, Kafka, MCP; transparent proxy; DLP; secret backends). Screenshots: capture Overview + Decision view + Approvals via `agent-browser` against the running stack into `docs/screenshots/`.

## Final verification loop (definition of done, from master plan)

- [ ] 1. `make reset && make setup && docker compose up --build -d && make demo` → exit 0, all cases pass.
- [ ] 2. `make test` green including leak scan.
- [ ] 3. Red-line audit: grep enforcement tree for imports of management tree → zero; grep repo for hardcoded token outside env/compose/fixtures → zero; `console.log` in gateway src → zero.
- [ ] 4. Fresh-eyes pass of SPEC.md Part 1 checklist vs implementation; list gaps honestly in README "Status" section.
- [ ] 5. Screenshots + README finalization. Commit.

## Exit criteria

A newcomer can clone, run 4 commands, watch the 6-case demo pass, open the UI, and read why every decision happened.
