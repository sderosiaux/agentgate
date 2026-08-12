# Threat model

AgentGate's claim is narrow: an agent can do authenticated work against an external service without ever holding that service's credential, and every action it takes is decided at runtime. This document says which parts of that claim the prototype actually enforces, which parts it enforces halfway, and which parts depend entirely on how you deploy it.

Status markers:

- ✅ **mitigated in the prototype** — the code enforces it and a test proves it
- ⚠️ **partial** — enforced, with a gap named below
- ❌ **deployment control required** — the prototype does not enforce it at all

Nothing here is aspirational. If a row says ✅ there is a test; if it says ❌ it means you have to do something outside this repository.

---

## The threats the SPEC asks about

| Threat                                                 | Status                  | What stops it                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent reads the real credential                        | ✅                      | The proxy request carries an alias. The gateway reads credential metadata with an explicit `select` that does not fetch the ciphertext, and only calls `secretStore.getByAlias` after a verdict of ALLOW. Plaintext exists in gateway memory, for the duration of one `fetch`, and is never in a response body, an audit row, a log line, an error, or a console page.              |
| Agent requests another repository                      | ✅                      | Two independent refusals, either of which is enough: the mission's network rules must allow the path, and the mission's resource scope must cover the resource the gateway parsed. Demo case 3 exercises both. The credential can read `acme/secret-project`, and the request is refused anyway.                                                                                    |
| Agent points the credential at another host            | ✅                      | Each credential names the logical host it may be used against. `api.github.com` and `evil.example.com` are different hosts, and an alias scoped to the first cannot be spent on the second, whatever the mission's network rules say.                                                                                                                                               |
| Agent switches HTTP method                             | ✅                      | The method is part of the network rule match and part of the `(method, path) → action` mapping. `GET /repos/{o}/{r}` and `DELETE /repos/{o}/{r}` map to `repo.read` and `repository.delete`, and a mission grants those separately.                                                                                                                                                 |
| Agent reuses an approval                               | ✅                      | Consumption is one conditional `UPDATE ... WHERE status = 'approved'`. Two concurrent uses race and one loses. Demo case 4 replays the grant immediately and gets `approval ... has already been used`.                                                                                                                                                                             |
| Agent spends an approval on a different request        | ✅                      | The grant carries `requestHash`, a sha256 of the method, host, normalized path and body hash — the same four things the human was shown. It is one more equality in the same conditional `UPDATE`. A grant issued for merging pull request 7 is refused on pull request 9, on a different body, and on a different method.                                                          |
| Agent names a credential its mission was never issued  | ✅                      | The mission lists the aliases it may spend, and the gateway checks that list before it reads the credential row. An alias belonging to another mission and an alias that names nothing are refused with the same code, the same status and the same sentence, so the refusal cannot be used to find out which aliases exist.                                                        |
| Mission claims to run in a different environment       | ✅                      | `PolicyInput.environment.name` comes from the gateway's own configuration. The mission's own label is passed separately as `mission.label`, so a rule written about production cannot be talked out of by a mission that calls itself development.                                                                                                                                  |
| Agent reuses an expired mission token                  | ✅                      | The JWT has an `exp`, and the mission is re-read and re-checked on every single request, so a token still inside its own validity window is refused the moment the mission behind it expires. Demo case 6 does exactly this.                                                                                                                                                        |
| Secret-like content leaves through an allowed endpoint | ❌                      | There is no content inspection. `PolicyInput.data` carries `contentType`, `bodySize` and `bodyHash` and nothing else, so a request that is allowed can carry anything in its body. A DLP stage would slot into that field without an API change; none exists.                                                                                                                       |
| Agent bypasses the gateway entirely                    | ⚠️ demo / ❌ production | In compose, the agent sits alone on `agent-net`, which is `internal: true` — no route to the upstream, the database or the internet. That is a property of the compose file, not of AgentGate. In production nothing in this repository forces an agent's traffic through the gateway. See "Deployment requirements".                                                               |
| Gateway logs the credential                            | ✅                      | A pino serialiser strips `authorization` and `x-agentgate-*`, and every credential value the gateway decrypts is registered with a scrubber that replaces it anywhere in a log line, including inside error messages and stack traces and including its JSON-escaped spelling. `scripts/leak-scan.mjs` then reads the actual output of a real run and fails on a single occurrence. |
| The database holds readable secrets                    | ⚠️                      | AES-256-GCM, fresh 12-byte IV per secret, key from `AGENTGATE_MASTER_KEY` and nowhere else; the gateway refuses to boot without it. The leak scan dumps every row of every table as JSON and finds no plaintext. **No key rotation exists**: re-keying today means re-writing every credential by hand.                                                                             |
| The gateway process is compromised                     | ❌                      | Out of scope, and worth stating plainly: this process holds the master key and every decrypted credential that passes through it. Anyone who can read its memory, attach a debugger, or run code inside it has everything. Production wants a KMS or HSM holding the key, and the gateway isolated from anything else.                                                              |
| Upstream acts and the trail loses the outcome          | ⚠️                      | See below.                                                                                                                                                                                                                                                                                                                                                                          |

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

### An approval now pins the request, and what that costs

This used to say a grant binds `(agent, mission, resource, action)` and nothing else, and that a human could therefore approve summary A while the grant was spent on request B. That was true, and it was worse than the wording suggested: the substitution left no trace anywhere. An independent review walked it through and the trade-off got made.

A grant carries `requestHash` — sha256 over the method, the host, the normalized path and the hash of the body, which are the four things the console already showed. It is checked in the same conditional `UPDATE` that spends the grant, so the atomicity that stops two retries from both winning is unchanged.

The cost is the one the old wording named, and it is real. A legitimate retry with a regenerated body is a different request and is refused: an agent that rebuilds its JSON with a timestamp in it, or serialises keys in a different order, gets `approval ... does not authorise this request` and has to ask again. The same applies to the idempotent-pending lookup, which now keys on the request too — two merges of two different pull requests open two approvals, and a human decides both.

A request with no body and one with an empty body hash the same. They send the same bytes upstream, so they are the same question.

Approvals granted before the migration that added the column carry an empty hash and authorise nothing.

### A mission's credential list is only as narrow as whoever wrote it

Until an independent review pointed it out, the `credential` field of a proxy envelope was the agent's free choice. The gateway loaded whatever alias it named and checked only that the credential was active and that its logical host matched the url. Nothing anywhere said which keys a mission had been issued, so an agent on a read-only mission could name a production admin alias on the same host and have it injected into an otherwise policy-allowed request. It only needed to know or guess the alias.

`permissions.allowedCredentials` is the list, and the gateway checks it before it reads the credential row. That order is the control rather than a detail: comparing after the read would answer two questions where the agent is entitled to one, and the pair of refusals would be a directory of the credential store, one guess at a time.

What remains is the ordinary shape of any allow-list. It is written by whoever issues the mission, and a mission that lists every alias grants every alias. Nothing warns about that, and there is no notion of a credential that may only be attached to certain missions — the binding lives on the mission, not on the credential.

The field is required, so a permissions document written before it existed does not parse, and a mission the gateway cannot read grants nothing. Missions already in a database are given the empty list by migration: readable, and granting no credential at all. Absent never means all. In practice that means every mission in a live database stops working at the credential stage until someone reissues it, which is the direction to fail in and is still a break.

### Grant expiry is lazy, and so is mission revocation on the status route

Grants expire five minutes after approval. Nothing sweeps them: expiry is evaluated when the grant is spent. The agent-facing `GET /v1/approvals/:id` reports an expired grant as `approved`, because it reads the stored status rather than recomputing it against the clock. The refusal is correct when the agent actually tries to use it; the status route just reads optimistically.

The same route deliberately does not re-check whether the mission was revoked. It is read-only and reveals nothing; the enforcement path is where revocation is caught.

### Expiry is clock-injected, which multiple replicas would notice

Mission and grant expiry are evaluated against an injected clock, which is what makes them testable. Two gateway replicas with drifting clocks will disagree about whether a mission has expired, and there is no fencing token or shared authority to break the tie. Single-instance behaviour is correct. A fleet needs the deadline checked in the database rather than in the process.

### The byte budget bounds the overshoot, and bounds concurrency with it

This section used to claim the overshoot was one response. It was not. `maxBytes` was _read_, compared, and left alone until the upstream had answered, so every request in flight saw the same remaining budget and every one of them was given a response allowance computed from it. Ten simultaneous requests overshot by ten responses. The same independent review found it.

Bytes are booked before they are spent now, in two steps. The request body is booked at step 3, in one conditional statement that decides on the row it locks — a second caller cannot pass a condition the first has already used up. The response allowance is booked immediately before the forward and given back immediately after, because it is the large one and a request waiting for a human must not be holding it.

The overshoot is bounded by one reservation: 8 MiB plus the 256 KiB of slack, however many requests are in flight. The 8 MiB is the request body limit read from the other direction, and it is also the trade-off. A mission can have at most `maxBytes / (8 MiB + 256 KiB)` forwards in flight at once — five, on the demo's 50 MB budget — and the sixth gets a 429 naming the byte budget until one finishes. A mission that needs more parallelism needs a bigger budget, which is what a byte budget is for.

A single response can also no longer exceed 8.25 MiB, where before it could be anything the mission could still afford. And a request that had already spent an approval grant can, under heavy concurrency on a nearly-spent budget, be refused between consuming the grant and reaching the upstream. The grant paid for an attempt, and that is the attempt failing.

### An upstream can act on a request whose outcome is never recorded

The audit row is written in the pipeline's `finally`, which runs after the upstream has already done what it was told. If that write is the thing that fails — a lock, a full disk, a migration halfway through — the agent gets a 500 for a request that succeeded. It does not even get a request id, because the route never reaches the line that adds the header. It retries, and the side effect happens twice. For a one-time approval whose grant was already consumed, that is the worst shape this gateway has.

`ForwardIntent` is written and awaited immediately before the request leaves: one row per attempt that reaches an upstream, carrying the request id, the mission, the action, the destination, the credential alias and the approval id. A failure to write it refuses the request rather than hiding it, so nothing is forwarded that was not written down first. A row with no matching `AuditEvent` is a request that was sent and whose result nobody recorded:

```sql
SELECT f.* FROM "ForwardIntent" f
LEFT JOIN "AuditEvent" a ON a."requestId" = f."requestId"
 WHERE a."id" IS NULL;
```

That is a second table rather than a second audit row on purpose. The trail's contract is exactly one row per attempt, the README and several tests say so, and the append-only triggers refuse the `UPDATE` that appending an outcome to an existing row would need.

The window is narrower, not closed. You can now find out that a request was forwarded and its result lost; you still cannot find out what the upstream did with it. There is no management endpoint for the query above — it is SQL, in the migration and here. Nothing prunes the table either.

### A superuser can remove the append-only guard

`AuditEvent` is append-only through row-level and statement-level triggers, enabled `ALWAYS` so that `session_replication_role = replica` does not skip them, with the `TRUNCATE` path closed separately. All of that stops the application, and an operator who typed the wrong thing.

It stops nobody with superuser. `DROP TRIGGER` is available to the table owner, and **in the demo compose the application role is the superuser**, so the same role the gateway connects as could disable the guard and then rewrite history. Production wants the migration run by an owner role and the application connecting as a separate, non-owner role. Rows are also not hash-chained, so a database-level rewrite leaves no evidence.

### The audit recorder's key filter is a substring match

`record()` throws if any key in the payload matches `/authorization|credential|secret|password|cookie|token|value|^body$/i`. The match is unanchored, so it is checking for a _substring_: a future field named `maxTokens` matches `token`, and `limitValues` matches `value`.

This fails closed: the recorder throws, the audit write fails, and because an unaudited request is not one this gateway will serve, every proxied request starts answering 500. That is the correct direction to fail in, with a very wide blast radius for what would look like an innocuous field rename.

Two keys are exempt by exact name, `credentialAlias` and `allowedCredentials`, both added when credentials were bound to missions. Both hold nothing but aliases — strings an operator typed and the management API already returns in plaintext — and the value behind an alias is not resolved until after the policy snapshot is built. The exemption is a set of literal names rather than a hole in the pattern, so the pattern still catches the field nobody thought about: `credentials`, `credentialValue` and `allowedCredential` are not on the list and still throw.

### Introspection defeats the credential guard

The resolved credential object hides its value behind a non-enumerable property, so it does not appear in `console.log`, `JSON.stringify` or an accidental spread. `util.inspect(cred, { showHidden: true })` prints it.

That is the intended limit. The guard exists to stop a credential falling into a log through ordinary carelessness. It is not a defence against code in the same process that is deliberately looking, and nothing in a Node process could be.

### Rate-limit rows are never pruned

Requests-per-minute is a fixed one-minute window: one `RateWindow` row per mission per minute, and nothing ever deletes them. A long-lived mission writes 1,440 rows a day and keeps every one. Correct, and unbounded. Production wants a sliding window in Redis, or at minimum a retention job.

### The gateway image is a build image

`apps/gateway/Dockerfile` copies the whole workspace into the runtime stage, so the running container carries `tsx`, the Prisma CLI, `vitest` and the mock-github sources. The entrypoint needs the Prisma CLI to migrate and seed, which is how it started; the rest came along with it.

It also **runs as root**, and it is not alone: **demo-agent and mock-github run as root too**. Only the web image drops privileges, with a `USER node` its Next standalone output made easy. Three of the four should have that line and do not.

None of this is exploitable on its own. All of it widens what an attacker who reached code execution can do next, and the gateway is the container that holds the master key.

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
