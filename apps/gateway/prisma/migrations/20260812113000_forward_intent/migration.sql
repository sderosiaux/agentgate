-- Nothing is forwarded before the intent to forward it is durable.
--
-- The audit row is written in the pipeline's `finally`, which is after the upstream has already
-- acted on the request. An audit-table-specific failure at that moment — a full disk, a lock, a
-- migration halfway through — turns a request that succeeded into a 500 with no record of it.
-- The agent retries, and the side effect happens twice. For a one-time approval whose grant was
-- already consumed, that is the worst shape this gateway has.
--
-- One row here per attempt that reaches an upstream, written and awaited before the request
-- leaves. A row with no matching AuditEvent is a request that was sent and whose outcome nobody
-- recorded:
--
--   SELECT f.* FROM "ForwardIntent" f
--   LEFT JOIN "AuditEvent" a ON a."requestId" = f."requestId"
--    WHERE a."id" IS NULL;
--
-- A separate table rather than a second AuditEvent row, deliberately. The trail's contract is
-- exactly one row per attempt, several tests and the README say so, and the append-only triggers
-- from 20260811025123 refuse the UPDATE that appending an outcome would need.
CREATE TABLE "ForwardIntent" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "principalId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "destHost" TEXT NOT NULL,
    "destPath" TEXT NOT NULL,
    "bodyHash" TEXT,
    "credentialAlias" TEXT NOT NULL,
    "approvalId" TEXT,

    CONSTRAINT "ForwardIntent_pkey" PRIMARY KEY ("id")
);

-- One attempt, one request id, one intent. A retry is a new request and gets its own row, which
-- is what makes "the same side effect twice" visible rather than merged away.
CREATE UNIQUE INDEX "ForwardIntent_requestId_key" ON "ForwardIntent"("requestId");

CREATE INDEX "ForwardIntent_timestamp_idx" ON "ForwardIntent"("timestamp");

CREATE INDEX "ForwardIntent_missionId_timestamp_idx" ON "ForwardIntent"("missionId", "timestamp");
