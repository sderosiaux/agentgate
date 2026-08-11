-- One pending approval per intent, enforced by the database.
--
-- Read-then-create is not idempotency: 24 concurrent first attempts through the proxy
-- produced 24 pending rows, every one of them approvable into its own single-use grant.
-- That is a human queue flooded by one intent, and N grants for a request the human meant
-- to allow once.
--
-- Collapse whatever the read-then-create version already left behind, oldest kept: those
-- rows are copies of one question, and the index below cannot be created while they exist.
UPDATE "Approval" AS duplicate
   SET "status" = 'expired'
  FROM "Approval" AS kept
 WHERE duplicate."status" = 'pending'
   AND kept."status" = 'pending'
   AND kept."missionId" = duplicate."missionId"
   AND kept."agentId" = duplicate."agentId"
   AND kept."resource" = duplicate."resource"
   AND kept."action" = duplicate."action"
   AND (kept."requestedAt", kept."id") < (duplicate."requestedAt", duplicate."id");

-- Partial unique indexes have no Prisma schema spelling, so this lives here and only here
-- (as the append-only triggers do). `prisma migrate dev` will report it as drift and offer
-- to drop it: it must be kept, and the concurrency test in approvals-flow.test.ts is what
-- notices if it ever goes.
CREATE UNIQUE INDEX "Approval_pending_intent_key"
    ON "Approval" ("missionId", "agentId", "resource", "action")
    WHERE "status" = 'pending';
