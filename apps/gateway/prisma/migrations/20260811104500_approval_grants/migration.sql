-- Who decided an approval. The management API is guarded by a single shared token,
-- which names nobody: the decision carries the name the caller gave for itself.
ALTER TABLE "Approval" ADD COLUMN "decidedBy" TEXT;

-- Approval lookups arrive with sub-plan 07: the pipeline asks "does this mission already
-- have a pending approval for this action?" on every REQUIRE_APPROVAL, and the management
-- list filters by status. Both are covered by this index.
CREATE INDEX "Approval_missionId_status_idx" ON "Approval"("missionId", "status");
