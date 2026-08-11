-- CreateTable
CREATE TABLE "Principal" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Principal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "agentType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mission" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "environment" TEXT NOT NULL DEFAULT 'development',
    "permissions" JSONB NOT NULL,
    "network" JSONB NOT NULL,
    "limits" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Mission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Credential" (
    "id" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "logicalHost" TEXT NOT NULL,
    "upstreamBaseUrl" TEXT NOT NULL,
    "injection" JSONB NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',

    CONSTRAINT "Credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "requestSummary" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "grantExpiresAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "principalId" TEXT,
    "agentId" TEXT,
    "missionId" TEXT,
    "resource" TEXT,
    "action" TEXT,
    "method" TEXT,
    "destHost" TEXT,
    "destPath" TEXT,
    "decision" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "matchedPolicy" TEXT,
    "approvalId" TEXT,
    "httpStatus" INTEGER,
    "latencyMs" INTEGER NOT NULL,
    "bodySize" INTEGER,
    "bodyHash" TEXT,
    "contentType" TEXT,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageCounter" (
    "missionId" TEXT NOT NULL,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "bytesTotal" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "UsageCounter_pkey" PRIMARY KEY ("missionId")
);

-- CreateTable
CREATE TABLE "RateWindow" (
    "missionId" TEXT NOT NULL,
    "minute" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RateWindow_pkey" PRIMARY KEY ("missionId","minute")
);

-- CreateIndex
CREATE UNIQUE INDEX "Credential_alias_key" ON "Credential"("alias");

-- CreateIndex
CREATE INDEX "AuditEvent_missionId_timestamp_idx" ON "AuditEvent"("missionId", "timestamp");

-- CreateIndex
CREATE INDEX "AuditEvent_decision_timestamp_idx" ON "AuditEvent"("decision", "timestamp");

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mission" ADD CONSTRAINT "Mission_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mission" ADD CONSTRAINT "Mission_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Audit log is append-only (SPEC D12): reject any UPDATE or DELETE on "AuditEvent"
-- at the database level, independently of the application code paths.
CREATE OR REPLACE FUNCTION audit_events_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'AuditEvent is append-only: % is not allowed', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_append_only
    BEFORE UPDATE OR DELETE ON "AuditEvent"
    FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
