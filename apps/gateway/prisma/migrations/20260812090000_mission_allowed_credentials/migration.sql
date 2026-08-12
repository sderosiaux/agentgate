-- Credentials are chosen by the mission, not by the agent.
--
-- Until now the `credential` field of a proxy envelope was the agent's free choice: the
-- gateway loaded whatever alias it named and checked only that the credential was active and
-- that its logical host matched the url. An agent holding a valid token for a read-only
-- mission could therefore name a production admin alias on the same host and have it injected,
-- because nothing in the mission document said which keys that mission was issued.
--
-- `permissions.allowedCredentials` is that missing sentence, and the gateway now refuses any
-- alias the mission does not list — before the credential row is read, so that the refusal
-- cannot be used to find out which aliases exist.
--
-- Every mission already in this database predates the field. Absent must not read as "all of
-- them", so they are given the empty list: readable, and granting no credential at all. Such a
-- mission answers every proxy request with the same refusal an unknown alias gets, and an
-- operator fixes it by issuing a new mission that names its credentials. The alternative was
-- to leave the documents unparseable, which denies just as hard but leaves rows in the
-- database that nothing can read back.
UPDATE "Mission"
   SET "permissions" = jsonb_set("permissions", '{allowedCredentials}', '[]'::jsonb, true)
 WHERE jsonb_typeof("permissions") = 'object'
   AND NOT ("permissions" ? 'allowedCredentials');

-- The demo mission the seed writes is re-seeded with its own alias on every `make db-seed`,
-- so it is deliberately not special-cased here.
