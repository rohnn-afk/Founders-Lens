\set ON_ERROR_STOP on
-- Pass reviewed values with -v expected_identity=SYSTEM:OID and
-- -v authority_identity=SYSTEM:OID. Run as each restricted login over verify-full.
BEGIN READ ONLY;

\ir verify-staging-target.sql

DO $verify$
DECLARE
  runtime_role oid := current_user::regrole;
BEGIN
  IF current_user <> session_user OR current_user NOT IN
      ('fl_p6_workspace', 'fl_p8_conversations', 'fl_staging_identity_reader')
    OR EXISTS (
      SELECT FROM pg_catalog.pg_roles WHERE oid = runtime_role
        AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls OR rolinherit OR NOT rolcanlogin)
    )
    OR EXISTS (SELECT FROM pg_catalog.pg_auth_members WHERE member = runtime_role)
    OR NOT has_database_privilege(runtime_role, current_database(), 'CONNECT')
    OR has_database_privilege(runtime_role, current_database(), 'CREATE,TEMPORARY')
    OR EXISTS (
      SELECT FROM pg_catalog.pg_namespace n
      WHERE has_schema_privilege(runtime_role, n.oid, 'CREATE')
    )
    OR EXISTS (
      SELECT FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND ((c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND has_table_privilege(runtime_role, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES'))
          OR (c.relkind = 'S' AND has_sequence_privilege(runtime_role, c.oid, 'USAGE,UPDATE')))
    )
    OR EXISTS (
      SELECT FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND a.attnum > 0 AND NOT a.attisdropped
        AND (has_column_privilege(runtime_role, c.oid, a.attnum, 'INSERT,REFERENCES')
          OR (has_column_privilege(runtime_role, c.oid, a.attnum, 'UPDATE')
            AND NOT (
              n.nspname = 'public' AND a.attname = 'updatedAt'
              AND ((current_user IN ('fl_p6_workspace', 'fl_p8_conversations') AND c.relname IN ('UserAccount', 'Idea'))
                OR (current_user = 'fl_p8_conversations' AND c.relname = 'Conversation'))
            )))
    )
    OR EXISTS (
      SELECT FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND has_schema_privilege(runtime_role, n.oid, 'USAGE') AND has_function_privilege(runtime_role, p.oid, 'EXECUTE')
    )
  THEN
    RAISE EXCEPTION 'STAGING_RESTRICTED_PRIVILEGE_DENIED';
  END IF;

  IF current_user = 'fl_staging_identity_reader' AND EXISTS (
    SELECT FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND has_any_column_privilege(runtime_role, c.oid, 'SELECT')
  ) THEN
    RAISE EXCEPTION 'STAGING_IDENTITY_READER_CONTENT_ACCESS';
  END IF;
END
$verify$;

SELECT current_user = 'fl_p6_workspace' AS workspace_role,
       current_user = 'fl_p8_conversations' AS transcript_role
\gset
\if :workspace_role
  SELECT id, status, "clerkSubject", "clerkInstanceId", "subjectKey", "subjectKeyVersion" FROM public."UserAccount" LIMIT 0;
  SELECT id, kind, "clerkInstanceId", "ownerSubjectKey", "subjectKeyVersion", "ideaId" FROM public."DataOperation" LIMIT 0;
  SELECT id, "clerkInstanceId", "subjectKey", "subjectKeyVersion" FROM public."IdentityTombstone" LIMIT 0;
  SELECT id, "ownerId", status, title, summary, version, "createdAt", "updatedAt" FROM public."Idea" LIMIT 0;
\elif :transcript_role
  SELECT id, status, "clerkSubject", "clerkInstanceId", "subjectKey", "subjectKeyVersion" FROM public."UserAccount" LIMIT 0;
  SELECT id, kind, "clerkInstanceId", "ownerSubjectKey", "subjectKeyVersion", "ideaId" FROM public."DataOperation" LIMIT 0;
  SELECT id, "clerkInstanceId", "subjectKey", "subjectKeyVersion" FROM public."IdentityTombstone" LIMIT 0;
  SELECT id, "ownerId", status, title, summary, version, "createdAt", "updatedAt" FROM public."Idea" LIMIT 0;
  SELECT id, "ideaId", title, status, "metadataVersion", "proactiveResearch", "createdAt", "updatedAt" FROM public."Conversation" LIMIT 0;
  SELECT id, "ideaId", "conversationId", sequence, role, content, "contentSchemaVersion", "generationAttemptId", "createdAt" FROM public."Message" LIMIT 0;
  SELECT id, "conversationId", "triggerMessageId", "selectedAt", status FROM public."GenerationAttempt" LIMIT 0;
\endif
ROLLBACK;

-- Check the lock ACL without locking any data rows or changing data.
BEGIN;
\if :workspace_role
  SELECT id FROM public."UserAccount" LIMIT 0 FOR UPDATE;
  SELECT id FROM public."Idea" LIMIT 0 FOR UPDATE;
\elif :transcript_role
  SELECT id FROM public."UserAccount" LIMIT 0 FOR UPDATE;
  SELECT id FROM public."Idea" LIMIT 0 FOR UPDATE;
  SELECT id FROM public."Conversation" LIMIT 0 FOR UPDATE;
\endif
ROLLBACK;
\echo STAGING_PRIMARY_RESTRICTED_LOGIN_VERIFIED
