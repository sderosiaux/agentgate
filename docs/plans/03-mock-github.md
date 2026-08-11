# Sub-plan 03 — Mock GitHub service

**Goal:** Standalone Fastify service imitating GitHub, guarded by a bearer token the agent must never see. Importable in-process for gateway integration tests (plan 06) and runnable as a compose service.

**Depends on:** 01. Independent of 02/04/05 — parallelizable.

## Files

- Create: `services/mock-github/src/app.ts` (exports `buildMockGithub(opts: {token: string}): FastifyInstance`), `src/index.ts` (reads `MOCK_GITHUB_TOKEN`, listens 3001), `src/fixtures.ts`, `package.json`, `Dockerfile`, tests
- Modify: `docker-compose.yml` — add `mock-github` on `service-net` ONLY (never `agent-net`)

## Behavior (binding)

- Every route requires `Authorization: Bearer <token>` where token = constructor opt (compose: `MOCK_GITHUB_TOKEN`). Wrong/missing → `401 {"message":"Bad credentials"}` (GitHub-style).
- Routes + fixtures:
  - `GET /repos/acme/payments` → 200 repo JSON
  - `GET /repos/acme/payments/issues/423` → 200 issue JSON (`title: "Payment webhook retries duplicate charges"`)
  - `POST /repos/acme/payments/pulls` → 201 `{number: 991, html_url, title from body}`
  - `GET /repos/acme/secret-project` → 200 repo JSON (**it works with the credential — proving AgentGate, not the credential, blocks it**)
  - `DELETE /repos/acme/payments` → 204 (**also works — same point**)
  - anything else → 404 `{"message":"Not Found"}`
- Echo header `x-request-id` if present (helps audit correlation tests).

## Tests (write first, `fastify.inject`)

401 without auth; 401 with wrong bearer; 200 issue 423 with correct bearer; 201 PR create returns number; 204 delete; 404 unknown route; secret-project accessible with credential.

## Tasks

- [ ] 1. Package scaffold + failing tests for the auth guard. Implement guard. Commit.
- [ ] 2. Routes + fixtures (TDD per route group). Commit.
- [ ] 3. Dockerfile + compose entry (service-net only) + healthcheck. Verify `docker compose up mock-github` then in-network curl with bearer → 200. Commit.

## Exit criteria

Service green in tests and compose; `docker-compose.yml` shows `mock-github` absent from `agent-net`.
