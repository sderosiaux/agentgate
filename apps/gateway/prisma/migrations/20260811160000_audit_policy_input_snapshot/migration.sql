-- What the engine was actually asked, kept next to what it answered.
--
-- A trail that records the verdict but not the question cannot answer "why did this go
-- through" a week later: the mission may have been edited, the adapter may map the path
-- differently now, and the row would still read ALLOW with no way to reconstruct the input.
--
-- Nullable on purpose. Most refusals happen before the engine is reached — no token, expired
-- mission, exhausted budget, unmapped action — and inventing a snapshot for those would put a
-- half-built input in the trail and call it the decision's input.
ALTER TABLE "AuditEvent" ADD COLUMN "policyInputSnapshot" JSONB;

-- Two filters the management audit list offers that the existing indexes do not cover
-- (they are keyed by mission and by decision). Reading the trail agent-first is what the
-- agent detail page does on every load.
CREATE INDEX "AuditEvent_agentId_timestamp_idx" ON "AuditEvent"("agentId", "timestamp");
CREATE INDEX "AuditEvent_principalId_timestamp_idx" ON "AuditEvent"("principalId", "timestamp");
CREATE INDEX "AuditEvent_requestId_idx" ON "AuditEvent"("requestId");
