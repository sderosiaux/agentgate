# Threat model

AgentGate's claim is narrow: an agent can do authenticated work against an external service without ever holding that service's credential, and every action it takes is decided at runtime. This document says which parts of that claim the prototype actually enforces, which parts it enforces halfway, and which parts depend entirely on how you deploy it.

Status markers:

- ✅ **mitigated in the prototype** — the code enforces it and a test proves it
- ⚠️ **partial** — enforced, with a gap named below
- ❌ **deployment control required** — the prototype does not enforce it at all

Nothing here is aspirational. If a row says ✅ there is a test; if it says ❌ it means you have to do something outside this repository.

---

## The threats the SPEC asks about

| Threat                                                        | Status                  | What stops it                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent reads the real credential                               | ✅                      | The proxy request carries an alias. The gateway reads credential metadata with an explicit `select` that does not fetch the ciphertext, and only calls `secretStore.getByAlias` after a verdict of ALLOW. Plaintext exists in gateway memory, for the duration of one `fetch`, and is never in a response body, an audit row, a log line, an error, or a console page.              |
| Agent requests another repository                             | ✅                      | Two independent refusals, either of which is enough: the mission's network rules must allow the path, and the mission's resource scope must cover the resource the gateway parsed. Demo case 3 exercises both. The credential can read `acme/secret-project`, and the request is refused anyway.                                                                                    |
| Agent points the credential at another host                   | ✅                      | Each credential names the logical host it may be used against. `api.github.com` and `evil.example.com` are different hosts, and an alias scoped to the first cannot be spent on the second, whatever the mission's network rules say.                                                                                                                                               |
| Agent switches HTTP method                                    | ✅                      | The method is part of the network rule match and part of the `(method, path) → action` mapping. `GET /repos/{o}/{r}` and `DELETE /repos/{o}/{r}` map to `repo.read` and `repository.delete`, and a mission grants those separately.                                                                                                                                                 |
| Agent reuses an approval                                      | ✅                      | Consumption is one conditional `UPDATE ... WHERE status = 'approved'`. Two concurrent uses race and one loses. Demo case 4 replays the grant immediately and gets `approval ... has already been used`.                                                                                                                                                                             |
| Agent reuses an expired mission token                         | ✅                      | The JWT has an `exp`, and the mission is re-read and re-checked on every single request, so a token still inside its own validity window is refused the moment the mission behind it expires. Demo case 6 does exactly this.                                                                                                                                                        |
| Secret-like content leaves through an allowed endpoint        | ❌                      | There is no content inspection. `PolicyInput.data` carries `contentType`, `bodySize` and `bodyHash` and nothing else, so a request that is allowed can carry anything in its body. A DLP stage would slot into that field without an API change; none exists.                                                                                                                       |
| Agent bypasses the gateway entirely                           | ⚠️ demo / ❌ production | In compose, the agent sits alone on `agent-net`, which is `internal: true` — no route to the upstream, the database or the internet. That is a property of the compose file, not of AgentGate. In production nothing in this repository forces an agent's traffic through the gateway. See "Deployment requirements".                                                               |
| Gateway logs the credential                                   | ✅                      | A pino serialiser strips `authorization` and `x-agentgate-*`, and every credential value the gateway decrypts is registered with a scrubber that replaces it anywhere in a log line, including inside error messages and stack traces and including its JSON-escaped spelling. `scripts/leak-scan.mjs` then reads the actual output of a real run and fails on a single occurrence. |
| The database holds readable secrets                           | ⚠️                      | AES-256-GCM, fresh 12-byte IV per secret, key from `AGENTGATE_MASTER_KEY` and nowhere else; the gateway refuses to boot without it. The leak scan dumps every row of every table as JSON and finds no plaintext. **No key rotation exists**: re-keying today means re-writing every credential by hand.                                                                             |
| The gateway process is compromised                            | ❌                      | Out of scope, and worth stating plainly: this process holds the master key and every decrypted credential that passes through it. Anyone who can read its memory, attach a debugger, or run code inside it has everything. Production wants a KMS or HSM holding the key, and the gateway isolated from anything else.                                                              |
| An approval authorises a different request than the one shown | ⚠️                      | See below.                                                                                                                                                                                                                                                                                                                                                                          |

---

## What the prototype does not defend, in detail

### The console has no authentication

The admin console has no authentication of its own. It holds `ADMIN_TOKEN` server-side and applies it on behalf of anyone who reaches its route handlers: approve, deny, expire a mission and mint an agent token are available without identification.

**Deployment constraint:** the web service must never be published beyond localhost or the compose network. Any exposure beyond that requires operator authentication first (a reverse proxy with SSO, or mTLS). The prototype provides none, and the handlers' CSRF controls protect against cross-site execution, not against direct access.

`docker-compose.yml` binds it to `127.0.0.1` with no override, which is the only reason the default is safe.

### Published ports, and why each one is where it is

Every port compose publishes is on `127.0.0.1`. Three of the four were not a decision worth agonising over:

- **postgres** — the password is `agentgate`, committed in `.env.example`. On `0.0.0.0` that is an open database.
- **opa** — the OPA API has no authentication, and `PUT /v1/policies` on an open one rewrites this deployment's authorization rules from the network.
- **web** — see above.

The **gateway** is the one real trade-off, and it defaults to loopback with `GATEWAY_BIND` as the escape hatch. The argument for exposing it is genuine: it is the enforcement point, and an agent running on another machine has to reach it. The argument against is that the same port serves `/api/v1`, so publishing the proxy publishes minting and approving as well, behind a single shared `ADMIN_TOKEN`. Splitting enforcement and management into two listeners would remove the tension; D11 already keeps them as separate plugin trees, so that is a compose change rather than a refactor. Until then, exposing the gateway means accepting that the management API is exposed too.

### An approval does not pin the request body

A grant binds `(agent, mission, resource, action)`. It does not bind the body. A human approving `pull_request.create` on `github:acme/payments` is approving that action, not the pull request title, branch or description in front of them.

Worse, the `requestSummary` shown in the console comes from the **first** request that triggered the approval. The agent retries with the grant, and the retry is a fresh request whose body nothing compares against the first. So a human can approve summary A while the grant is spent by request B, and neither the console nor the audit row would show a discrepancy.

Pinning `bodyHash` into the grant would close it, at the cost of making a legitimate retry with a regenerated body fail. That trade-off has not been made.

### Grant expiry is lazy, and so is mission revocation on the status route

Grants expire five minutes after approval. Nothing sweeps them: expiry is evaluated when the grant is spent. The agent-facing `GET /v1/approvals/:id` reports an expired grant as `approved`, because it reads the stored status rather than recomputing it against the clock. The refusal is correct when the agent actually tries to use it; the status route just reads optimistically.

The same route deliberately does not re-check whether the mission was revoked. It is read-only and reveals nothing; the enforcement path is where revocation is caught.

### Expiry is clock-injected, which multiple replicas would notice

Mission and grant expiry are evaluated against an injected clock, which is what makes them testable. Two gateway replicas with drifting clocks will disagree about whether a mission has expired, and there is no fencing token or shared authority to break the tie. Single-instance behaviour is correct. A fleet needs the deadline checked in the database rather than in the process.

### The byte budget can overshoot by one response

`maxBytes` is checked before forwarding using the **request** size, because the response size is not known yet. The response is then read with a cap of "whatever the mission has left, plus 256 KiB of slack", so a mission with almost nothing left can still receive a normal REST response instead of being cut off mid-body. Both are deliberate. The consequence is that a mission can end up over its byte budget by up to one response, and the overshoot is bounded by that cap rather than by the budget.

### A superuser can remove the append-only guard

`AuditEvent` is append-only through row-level and statement-level triggers, enabled `ALWAYS` so that `session_replication_role = replica` does not skip them, with the `TRUNCATE` path closed separately. All of that stops the application, and an operator who typed the wrong thing.

It stops nobody with superuser. `DROP TRIGGER` is available to the table owner, and **in the demo compose the application role is the superuser**, so the same role the gateway connects as could disable the guard and then rewrite history. Production wants the migration run by an owner role and the application connecting as a separate, non-owner role. Rows are also not hash-chained, so a database-level rewrite leaves no evidence.

### The audit recorder's key filter is a substring match

`record()` throws if any key in the payload matches `/authorization|credential|secret|password|cookie|token|value|^body$/i`. The match is unanchored, so it is checking for a _substring_: a future field named `maxTokens` matches `token`, and `limitValues` matches `value`.

This fails closed: the recorder throws, the audit write fails, and because an unaudited request is not one this gateway will serve, every proxied request starts answering 500. That is the correct direction to fail in, with a very wide blast radius for what would look like an innocuous field rename.

### Introspection defeats the credential guard

The resolved credential object hides its value behind a non-enumerable property, so it does not appear in `console.log`, `JSON.stringify` or an accidental spread. `util.inspect(cred, { showHidden: true })` prints it.

That is the intended limit. The guard exists to stop a credential falling into a log through ordinary carelessness. It is not a defence against code in the same process that is deliberately looking, and nothing in a Node process could be.

### Rate-limit rows are never pruned

Requests-per-minute is a fixed one-minute window: one `RateWindow` row per mission per minute, and nothing ever deletes them. A long-lived mission writes 1,440 rows a day and keeps every one. Correct, and unbounded. Production wants a sliding window in Redis, or at minimum a retention job.

### The gateway image is a build image

`apps/gateway/Dockerfile` copies the whole workspace into the runtime stage, so the running container carries `tsx`, the Prisma CLI, `vitest` and the mock-github sources. The entrypoint needs the Prisma CLI to migrate and seed, which is how it started; the rest came along with it. It also **runs as root**, where the web image drops to `USER node`.

Neither is exploitable on its own. Both widen what an attacker who reached code execution can do next, in the one container that holds the master key.

### `/api/docs` is public

The OpenAPI document and its browsable UI are served without the admin token, while `/api/v1` refuses to confirm whether a route exists to a caller who lacks one. That is a deliberate inconsistency: the UI fetches its own definition from the browser before any operator has typed a token, so a guarded document is one nobody can read.

The cost is that route names are published. Set against an admin token required on every one of them, that is a map of a locked door. A test walks the generated document looking for a credential value, so what is published is shape and never data.

Which routes end up in that document depends on Fastify's encapsulation: the enforcement routes are registered outside the swagger plugin's scope, and a test asserting that `/v1/proxy` never appears is the only mechanism keeping it that way. Move a `register` call and the tripwire is what catches it.

---

## Things that look like weaknesses and are not

Demo case 2 dumps the agent's entire environment, `AGENTGATE_TOKEN` included, because the point of the case is to show exactly what an agent holds. That token opens one mission for at most an hour, and case 6 expires that mission in the same run, so by the time the output reaches a CI archive the token in it is already dead. Deliberate, not lucky.

`ApprovalTimeoutError` is not a `TimeoutError`, and not a `TransportError` either, despite how it reads. Nothing timed out on the wire and nothing failed: every poll got an answer, and the answer was that the approval is still pending. What ran out is a human's attention, which is not retryable the way a dropped connection is.

The SDK's dependency list looks lopsided: zero runtime dependencies, and a devDependency list that includes the entire gateway. Both are on purpose. It is the one package that ships inside an agent's sandbox, so a runtime dependency there would be code running next to a mission token. Its tests run a real gateway in-process rather than mocking one, which is where the gateway comes from. A consumer installs none of it.

---

## What the demo does not prove

Case 0 has never run, anywhere. Network isolation is the one case that needs the compose networks, and no Docker daemon has been available on the machine this was built on. Host mode marks it `SKIP` and says why rather than quietly passing it. What would make the claim true is `agent-net: internal: true` in the compose file; nobody has yet watched it be true.

Its evidence would also be misleading on an offline runner. Case 0 proves isolation partly by failing to reach `example.com`, and on a machine with no internet that failure says nothing about the network policy: it says there is no internet. The structural claim holds either way, but the printed evidence line only means something on a runner that has internet to be denied.

Case 2 has a similar asymmetry. It greps a filesystem for the upstream token, and that filesystem is `/app` in the container, the whole application. On the host it is `apps/demo-agent` and nothing else. The two runs are not equivalent, and the container one is the run that proves something.

---

## Deployment requirements

None of this is optional if you run AgentGate anywhere real.

1. **Force agent egress through the gateway.** This is the load-bearing one. A sandbox network policy, an egress firewall, or a Kubernetes `NetworkPolicy`: something outside AgentGate that makes the gateway the only reachable route out. Every guarantee above is void for an agent that can open its own socket.
2. **Authenticate the console.** Put SSO or mTLS in front of it, or do not expose it. It has no login of its own and applies `ADMIN_TOKEN` for anyone who reaches it.
3. **Generate fresh secrets.** `node scripts/generate-env.mjs`. Every value in `.env.example` is committed to a public repository, including the master key and the admin token.
4. **Protect `ADMIN_TOKEN` like a root credential.** It mints agent tokens and approves approvals. There is one of them, it does not expire, and there are no roles.
5. **Put TLS in front of everything.** The gateway speaks plain HTTP. A mission token in a header on a plaintext hop is a mission token anyone on the path can replay until it expires.
6. **Split database roles.** Run the migrations as an owner, connect the application as a non-owner. Otherwise the append-only audit trail is append-only only by convention.
7. **Hold the master key outside the process.** `AGENTGATE_MASTER_KEY` in an environment variable is fine for a demo and is the weakest link in production. A KMS or an HSM, and a rotation plan, which the prototype does not have.
8. **Give the gateway its own isolation.** It is the one component holding the key and the decrypted secrets. Its own host, its own network segment, no co-tenancy.
