-- Local M02 foundation only. No purge owner, purge entrypoint or role membership.
BEGIN;
DO $$ BEGIN
  IF current_user <> 'fl_m02_migrator' OR current_database() NOT IN
    ('founders_lens_m02_dev', 'founders_lens_m02_test') THEN
    RAISE EXCEPTION 'M02 privilege target rejected';
  END IF;
END $$;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO fl_m02_runtime;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM fl_m02_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE
  "UserAccount", "Idea", "Conversation", "Message", "GenerationAttempt",
  "MemoryProposal", "ConfirmedMemory", "MemoryRevision", "Assumption", "Experiment",
  "Learning", "ResearchJob", "EvidenceRecord", "AssumptionEvidence", "LearningEvidence",
  "DocumentSnapshot", "ExportJob", "OutboxEvent", "AuditEvent", "UsageLedger",
  "DataOperation", "IdempotencyRecord", "WebhookInbox", "IdentityTombstone"
TO fl_m02_runtime;
-- UPDATE remains for the Learning row lock in the approved capture trigger;
-- immutable-history triggers reject actual updates, including owner-issued ones.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fl_privacy_delete_authorized(uuid) TO fl_m02_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE fl_m02_migrator IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE fl_m02_migrator IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
COMMIT;
