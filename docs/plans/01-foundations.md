# Sub-plan 01 — Foundations

**Goal:** Monorepo scaffold + Postgres + Prisma schema + seed + compose + Makefile. `docker compose up` yields a healthy DB and a gateway placeholder answering `/healthz`.

**Depends on:** nothing. **Blocks:** everything.

## Files

- Create: `package.json` (root, private, scripts: `typecheck`, `test`, `format`), `pnpm-workspace.yaml` (`apps/*`, `packages/*`, `services/*`), `tsconfig.base.json` (strict, NodeNext, ES2022), `.gitignore`, `.env.example`, `.prettierrc`
- Create: `docker-compose.yml`, `Makefile`
- Create: `apps/gateway/package.json`, `apps/gateway/tsconfig.json`, `apps/gateway/src/index.ts` (Fastify with `/healthz` only), `apps/gateway/Dockerfile`
- Create: `apps/gateway/prisma/schema.prisma`, `apps/gateway/prisma/seed.ts`, migration with audit-guard trigger
- Create: `scripts/generate-env.mjs` (fresh `AGENTGATE_MASTER_KEY` + Ed25519 JWT keypair → `.env`)

## Prisma schema (binding)

```prisma
model Principal {
  id        String    @id            // pri_xxx
  name      String
  agents    Agent[]
  missions  Mission[]
}

model Agent {
  id          String    @id          // agt_xxx
  principalId String
  agentType   String                 // codex | claude-code | ci | custom
  createdAt   DateTime  @default(now())
  principal   Principal @relation(fields: [principalId], references: [id])
  missions    Mission[]
}

model Mission {
  id          String   @id           // mis_xxx
  principalId String
  agentId     String
  intent      String
  status      String   @default("active")  // active | expired | revoked
  environment String   @default("development")
  permissions Json     // MissionPermissions (zod-validated, plan 02)
  network     Json     // NetworkRules
  limits      Json     // MissionLimits
  expiresAt   DateTime
  createdAt   DateTime @default(now())
  principal   Principal @relation(fields: [principalId], references: [id])
  agent       Agent     @relation(fields: [agentId], references: [id])
}

model Credential {
  id              String @id         // cred_xxx
  alias           String @unique     // github_work
  provider        String             // github
  logicalHost     String             // api.github.com
  upstreamBaseUrl String             // http://mock-github:3001 (demo)
  injection       Json               // {type:"header",name:"Authorization",format:"Bearer {value}"}
  ciphertext      Bytes              // AES-256-GCM: iv(12) || tag(16) || data
  status          String @default("active")
}

model Approval {
  id             String    @id       // apr_xxx
  missionId      String
  agentId        String
  resource       String
  action         String
  requestSummary Json                // {method, host, path, bodySize, contentType}
  reason         String
  status         String    @default("pending") // pending|approved|denied|expired|consumed
  requestedAt    DateTime  @default(now())
  decidedAt      DateTime?
  grantExpiresAt DateTime?
  consumedAt     DateTime?
}

model AuditEvent {
  id            String   @id         // aud_xxx
  requestId     String               // req_xxx
  timestamp     DateTime @default(now())
  principalId   String?
  agentId       String?
  missionId     String?
  resource      String?
  action        String?
  method        String?
  destHost      String?
  destPath      String?
  decision      String               // ALLOW | DENY | REQUIRE_APPROVAL | ERROR
  reason        String
  matchedPolicy String?
  approvalId    String?
  httpStatus    Int?
  latencyMs     Int
  bodySize      Int?
  bodyHash      String?
  contentType   String?
  @@index([missionId, timestamp])
  @@index([decision, timestamp])
}

model UsageCounter {
  missionId    String @id
  requestCount Int    @default(0)
  bytesTotal   BigInt @default(0)
}

model RateWindow {
  missionId String
  minute    DateTime   // truncated to minute
  count     Int @default(0)
  @@id([missionId, minute])
}
```

Migration extra (raw SQL in the migration file): trigger `audit_events_append_only` raising an exception on UPDATE/DELETE of `AuditEvent` rows.

## Compose (binding shape)

Networks: `agent-net` (`internal: true`), `service-net`. Services now: `postgres` (service-net, healthcheck), `gateway` (both networks, depends_on postgres healthy, runs migrations then boots). `mock-github`, `web`, `demo-agent`, `opa` are added by later plans — reserve names.

## Env (`.env.example`, DEV-ONLY values, loudly commented)

```text
DATABASE_URL=postgresql://agentgate:agentgate@postgres:5432/agentgate
AGENTGATE_MASTER_KEY=<base64 32B, dev-only value committed>
AGENTGATE_JWT_PRIVATE_KEY=<base64 PKCS8 Ed25519, dev-only>
AGENTGATE_JWT_PUBLIC_KEY=<base64 SPKI>
ADMIN_TOKEN=dev-admin-token
MOCK_GITHUB_TOKEN=super-secret-github-token
POLICY_ENGINE=builtin
ENVIRONMENT=development
DEMO_AUTO_APPROVE=1
```

NOTE: real deployments must run `node scripts/generate-env.mjs`; README will state it.

## Seed (`prisma/seed.ts`)

Idempotent (upserts): principal `pri_stephane`, agent `agt_demo` (type codex), credential `github_work` (encrypts `MOCK_GITHUB_TOKEN` with the master key — depends on crypto util from plan 04; until then seed stores a placeholder and plan 04 rewires it — acceptable, seed is re-run), mission `mis_demo` matching SPEC Part 1 "Missions" example (allowed: repo.read, issue.read, pull_request.read, branch.create, pull_request.create; approval: pull_request.create; denied: pull_request.merge, repository.delete; network allow api.github.com GET `/repos/acme/payments/**` + POST `/repos/acme/payments/pulls`; limits 500 req / 50 MB / 60 rpm; expires +60 min from seed run).

## Makefile

`setup` (pnpm i + generate-env if no .env), `dev` (compose up), `test` (pnpm -r test), `demo` (plan 09 fills in), `reset` (compose down -v).

## Tasks

- [ ] 1. Root scaffold (pnpm, tsconfig, prettier, gitignore) — `pnpm i` clean. Commit.
- [ ] 2. Gateway placeholder: failing test first (`vitest` + `fastify.inject` on `/healthz` → 200 `{status:"ok"}`), implement, pass. Commit.
- [ ] 3. Prisma schema + migration + append-only trigger. Test: insert audit row then `UPDATE` via `$executeRaw` → expect throw. Requires Postgres: use `DATABASE_URL_TEST` against compose postgres (document `make dev-db` target starting postgres alone). Commit.
- [ ] 4. Seed script + `prisma db seed` wiring; test: run twice, counts stable (idempotent). Commit.
- [ ] 5. Dockerfile + compose with both networks; verify `docker compose up --build gateway` healthy, `curl localhost:8080/healthz`. Commit.
- [ ] 6. Makefile + `.env.example` + `scripts/generate-env.mjs` (test: generated key decodes to 32 bytes; JWT keys import via `jose`). Commit.

## Exit criteria

`docker compose up --build` → postgres healthy, gateway `/healthz` 200, seed applied. `pnpm -r test` green. Checkpoint written.
