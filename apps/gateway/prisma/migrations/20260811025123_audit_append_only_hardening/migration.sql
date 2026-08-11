-- Two ways around the row-level append-only guard (SPEC.md D12), closed here.

-- TRUNCATE fires no row-level trigger, so it emptied the table unnoticed.
-- A TRUNCATE trigger is necessarily FOR EACH STATEMENT.
CREATE OR REPLACE FUNCTION audit_events_no_truncate() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'AuditEvent is append-only: % is not allowed', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_no_truncate
    BEFORE TRUNCATE ON "AuditEvent"
    FOR EACH STATEMENT EXECUTE FUNCTION audit_events_no_truncate();

-- `SET session_replication_role = replica` skips ORIGIN triggers, which is the
-- default. ALWAYS triggers fire whatever the session role is.
ALTER TABLE "AuditEvent" ENABLE ALWAYS TRIGGER audit_events_append_only;
ALTER TABLE "AuditEvent" ENABLE ALWAYS TRIGGER audit_events_no_truncate;
