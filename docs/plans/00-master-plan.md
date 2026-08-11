# AgentGate — Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement, one sub-plan at a time, in the order below. Each sub-plan produces working, tested software on its own.

**Goal:** Prove that an AI agent can do authenticated work against an external service without ever holding the credential, with a runtime authorization decision on every request.

**Architecture:** Monorepo. A Fastify gateway holds the enforcement path (`POST /v1/proxy`: authn → mission → limits → network policy → action mapping → policy decision → approval gate → credential injection → forward → audit). A Next.js app is a pure client of the gateway's management API. A mock GitHub service and a network-isolated demo agent prove the model end to end.

**Tech Stack:** TypeScript, pnpm workspaces, Fastify, Next.js, PostgreSQL, Prisma, `jose` (Ed25519 JWT), `node:crypto` (AES-256-GCM), Vitest, OPA (optional engine), Docker Compose.

**Binding decisions:** `SPEC.md` Part 2 (D1–D15). Any conflict between a sub-plan and SPEC.md Part 2 → Part 2 wins.

---

## Sub-plans and ordering

| # | Plan | Produces | Depends on |
|---|------|----------|-----------|
| 01 | [Foundations](01-foundations.md) | Monorepo scaffold, compose, Prisma schema, seed, Makefile | — |
| 02 | [Shared + Auth](02-shared-and-auth.md) | `packages/shared` (types, errors, ids), `packages/auth` (Ed25519 tokens) | 01 |
| 03 | [Mock GitHub](03-mock-github.md) | `services/mock-github` standalone Fastify service | 01 |
| 04 | [Secret store](04-secrets.md) | `SecretStore` interface + AES-256-GCM DB impl | 01, 02 |
| 05 | [Policy engine](05-policy.md) | `packages/policy`: URL normalization, network matching, GitHub adapter, builtin engine, OPA parity | 02 |
| 06 | [Gateway enforcement](06-gateway-enforcement.md) | `/v1/proxy` full pipeline: limits, injection, forwarding, audit | 02, 03, 04, 05 |
| 07 | [Approvals](07-approvals.md) | Approval records, single-use grants, retry flow | 06 |
| 08 | [Management API](08-management-api.md) | CRUD + token minting + OpenAPI + admin auth | 06, 07 |
| 09 | [SDK + Demo](09-sdk-and-demo.md) | `packages/sdk`, `apps/demo-agent`, network isolation, `make demo` (6 cases) | 08 |
| 10 | [Web UI](10-web-ui.md) | Next.js: Overview, Agents, Missions, Policies, Credentials, Approvals, Audit, Decision view | 08 |
| 11 | [Hardening](11-hardening.md) | THREAT_MODEL.md, secret-leak test, README, final verification | 09, 10 |

Dependency graph:

```text
01 ──┬── 02 ──┬── 04 ──┐
     │        ├── 05 ──┼── 06 ── 07 ── 08 ──┬── 09 ──┐
     └── 03 ──┴────────┘                    └── 10 ──┴── 11
```

Parallelizable pairs: (03, 04, 05) after 02; (09, 10) after 08.

## Working agreements

- **TDD per task**: each sub-plan lists the tests; write them first, watch them fail, implement, pass, commit. Commit after every green task (`feat:`/`test:`/`chore:` prefixes).
- **Step expansion**: sub-plans define files, interfaces, schemas, and test lists. At execution start of each sub-plan, expand its tasks to step-level TDD checklists using the interfaces given — the seams here are binding, the internals are the implementer's.
- **Red lines** (checked again in plan 11): no credential value ever crosses `SecretStore` → forwarder boundary except inside the outbound header; no `console.log` in gateway request path (pino only, through the redacting serializer); enforcement plugins never import management plugins.
- **Definition of done for the whole project**: `docker compose up --build` + `make demo` passes all 6 cases; `make test` green; secret-leak grep test green; README + THREAT_MODEL.md complete.

## Verification gates (end of each sub-plan)

1. `pnpm -r typecheck && pnpm -r test` green.
2. New service boots in compose (where applicable).
3. Grep the new code for `super-secret` and hardcoded credential values — only seed/env files may define the demo secret.
4. Checkpoint note: done / verified / left.
