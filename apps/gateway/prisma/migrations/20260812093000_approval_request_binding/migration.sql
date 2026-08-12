-- An approval authorises the request a human was shown, and nothing else.
--
-- A grant used to be bound to (missionId, agentId, resource, action). Every one of those is a
-- class, not a request: the human saw "merge pull request 7" in the summary, but the grant said
-- "some pull_request.merge on acme/payments by this agent". The agent could trigger the
-- approval with a benign request, wait for the click, and then spend the grant on a different
-- pull request, a different path under the same action, or a different body. `tryConsume`
-- accepted it and the trail showed nothing wrong.
--
-- `requestHash` is sha256 over the method, the host, the normalized path and the hash of the
-- body — the four things the summary already showed. A request that differs in any of them is a
-- different question, which is the point.
ALTER TABLE "Approval" ADD COLUMN "requestHash" TEXT NOT NULL DEFAULT '';

-- The default exists only to fill the rows that are already here; every insert from now on
-- supplies the value. Those rows keep the empty string, which is not a sha256 of anything, so a
-- grant approved before this migration authorises no request at all. That is the safe
-- direction: an agent holding one has to ask again, and a human decides again.
ALTER TABLE "Approval" ALTER COLUMN "requestHash" DROP DEFAULT;

-- One pending approval per *request*, not per intent. Two merges of two different pull requests
-- are two questions and must be able to wait side by side; without widening the index the
-- second one would lose the insert and silently join the first one's approval, inheriting a
-- decision nobody made about it.
--
-- Partial unique indexes have no Prisma schema spelling, so this lives here and only here (as
-- the append-only triggers do). `prisma migrate dev` will report it as drift and offer to drop
-- it: it must be kept, and the concurrency tests in approvals-flow.test.ts and
-- approvals-request-binding.test.ts are what notice if it ever goes.
DROP INDEX "Approval_pending_intent_key";

CREATE UNIQUE INDEX "Approval_pending_request_key"
    ON "Approval" ("missionId", "agentId", "resource", "action", "requestHash")
    WHERE "status" = 'pending';
