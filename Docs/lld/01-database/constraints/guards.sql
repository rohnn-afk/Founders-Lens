-- Founder's Lens: SQL guards to append to a Prisma-generated migration.
-- Apply only AFTER Prisma-generated CREATE TYPE / CREATE TABLE / FK statements.
-- Requires PostgreSQL 15+. Re-run only in fresh migration; not a standalone idempotent script.
-- Snapshot immutability, generation selection, content provenance and structural checks.

CREATE UNIQUE INDEX "GenerationAttempt_one_active_per_conversation"
  ON "GenerationAttempt" ("conversationId")
  WHERE "status" IN ('PENDING'::"GenerationStatus", 'RUNNING'::"GenerationStatus", 'CANCEL_REQUESTED'::"GenerationStatus");

CREATE UNIQUE INDEX "GenerationAttempt_one_selected_per_user_turn"
  ON "GenerationAttempt" ("triggerMessageId")
  WHERE "selectedAt" IS NOT NULL;

ALTER TABLE "GenerationAttempt" ADD CONSTRAINT "generation_selected_only_if_complete"
  CHECK ("selectedAt" IS NULL OR "status" = 'COMPLETED'::"GenerationStatus");
ALTER TABLE "GenerationAttempt" ADD CONSTRAINT "generation_attempt_number_positive" CHECK ("attemptNumber" > 0);
ALTER TABLE "Message" ADD CONSTRAINT "message_sequence_positive" CHECK ("sequence" > 0);
ALTER TABLE "Message" ADD CONSTRAINT "user_message_requires_submission_key"
  CHECK (("role" = 'USER'::"MessageRole" AND "clientSubmissionKey" IS NOT NULL AND "submissionSha256" IS NOT NULL AND "generationAttemptId" IS NULL)
      OR ("role" = 'ASSISTANT'::"MessageRole" AND "clientSubmissionKey" IS NULL AND "submissionSha256" IS NULL AND "generationAttemptId" IS NOT NULL));
-- SYSTEM messages are intentionally disallowed for v1 user-visible transcript; system prompts stay outside Message.
ALTER TABLE "DocumentSnapshot" ADD CONSTRAINT "draft_revision_positive" CHECK ("draftRevision" > 0);
ALTER TABLE "Idea" ADD CONSTRAINT "idea_version_positive" CHECK ("version" > 0);
ALTER TABLE "Assumption" ADD CONSTRAINT "assumption_version_positive" CHECK ("version" > 0);
ALTER TABLE "Experiment" ADD CONSTRAINT "experiment_version_positive" CHECK ("version" > 0);
ALTER TABLE "ConfirmedMemory" ADD CONSTRAINT "memory_version_positive" CHECK ("currentVersion" > 0);
ALTER TABLE "MemoryRevision" ADD CONSTRAINT "memory_revision_version_positive" CHECK ("version" > 0);
ALTER TABLE "Conversation" ADD CONSTRAINT "conversation_next_sequence_positive" CHECK ("nextSequence" > 0);
ALTER TABLE "EvidenceRecord" ADD CONSTRAINT "evidence_date_range_valid"
  CHECK ("periodStart" IS NULL OR "periodEnd" IS NULL OR "periodStart" <= "periodEnd");
ALTER TABLE "EvidenceRecord" ADD CONSTRAINT "checked_source_requires_provenance"
  CHECK ("trust" <> 'SOURCE_CHECKED'::"EvidenceTrust" OR
    ("origin" = 'EXTERNAL_SOURCE'::"EvidenceOrigin" AND "sourceLocator" IS NOT NULL AND "retrievedAt" IS NOT NULL));
ALTER TABLE "DocumentSnapshot" ADD CONSTRAINT "approval_requires_metadata"
  CHECK (("status" <> 'APPROVED'::"SnapshotStatus") OR
    ("contentSha256" IS NOT NULL AND "approvedAt" IS NOT NULL AND "approvedById" IS NOT NULL));
ALTER TABLE "ExportJob" ADD CONSTRAINT "completed_export_has_artifact"
  CHECK ("status" <> 'COMPLETED'::"ExportStatus" OR
    ("objectKey" IS NOT NULL AND "fileSha256" IS NOT NULL AND "completedAt" IS NOT NULL
      AND "artifactState" IS NOT NULL AND "artifactExpiresAt" IS NOT NULL));
ALTER TABLE "MemoryProposal" ADD CONSTRAINT "review_metadata_present"
  CHECK ("status" = 'PROPOSED'::"ProposalStatus" OR "status" = 'INVALIDATED'::"ProposalStatus" OR
    ("reviewedAt" IS NOT NULL AND "reviewedById" IS NOT NULL));
ALTER TABLE "MemoryProposal" ADD CONSTRAINT "target_version_consistency"
  CHECK (("targetMemoryId" IS NULL AND "expectedMemoryVersion" IS NULL) OR
    ("targetMemoryId" IS NOT NULL AND "expectedMemoryVersion" IS NOT NULL AND "expectedMemoryVersion" > 0));

-- Design migration fragment: role/entry-point grants are specified in physical-design §13.
-- This helper is SECURITY INVOKER: custom settings alone never grant purge authority.
CREATE OR REPLACE FUNCTION fl_privacy_delete_authorized(row_idea uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE op_id uuid; epoch integer;
BEGIN
  IF current_user <> 'fl_purge_owner' THEN RETURN false; END IF;
  op_id := nullif(current_setting('fl.purge_operation', true), '')::uuid;
  epoch := nullif(current_setting('fl.purge_epoch', true), '')::integer;
  RETURN EXISTS (
    SELECT 1 FROM public."DataOperation" d JOIN public."Idea" i ON i."id" = row_idea
    WHERE d."id" = op_id AND d."status" = 'RUNNING'::public."DataOperationStatus" AND d."leaseEpoch" = epoch AND d."leaseUntil" > statement_timestamp()
      AND d."deletionState" = 'PURGING'::public."DeletionState"
      AND i."status" = 'PURGING'::public."IdeaStatus"
      AND ((d."kind" = 'DELETE_IDEA'::public."DataOperationKind" AND d."ideaId" = row_idea)
        OR (d."kind" = 'DELETE_ACCOUNT'::public."DataOperationKind" AND d."accountId" = i."ownerId"))
  );
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;

CREATE OR REPLACE FUNCTION fl_prevent_immutable_revision_change() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP = 'DELETE' AND public.fl_privacy_delete_authorized(
    (SELECT "ideaId" FROM public."ConfirmedMemory" WHERE "id" = OLD."memoryId")
  ) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'immutable memory revision';
END $$;
CREATE TRIGGER fl_memory_revision_append_only
  BEFORE UPDATE OR DELETE ON "MemoryRevision"
  FOR EACH ROW EXECUTE FUNCTION fl_prevent_immutable_revision_change();

CREATE OR REPLACE FUNCTION fl_protect_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public.fl_privacy_delete_authorized(OLD."ideaId") THEN RETURN OLD; END IF;
    -- All ordinary approved-snapshot deletion remains forbidden.
    IF OLD."status" = 'APPROVED'::"SnapshotStatus" THEN
      RAISE EXCEPTION 'approved snapshot requires controlled purge';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" = 'APPROVED'::"SnapshotStatus" THEN
    RAISE EXCEPTION 'approved snapshot is immutable';
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."ideaId" <> OLD."ideaId" OR NEW."version" <> OLD."version" THEN
    RAISE EXCEPTION 'snapshot identity/version cannot change';
  END IF;
  -- Editing a review preview returns it to DRAFT; APPROVED remains protected.
  RETURN NEW;
END $$;
CREATE TRIGGER fl_snapshot_guard
  BEFORE UPDATE OR DELETE ON "DocumentSnapshot"
  FOR EACH ROW EXECUTE FUNCTION fl_protect_snapshot();

-- Required application invariants not representable as simple SQL checks:
-- * Authorization and idea ACTIVE state for every write, including worker commits.
-- * triggerMessage is USER and assistant output references a COMPLETED generation attempt;
--   enforce atomically in service or add reviewed deferred triggers.
-- * current memory version corresponds to the latest immutable MemoryRevision.
-- * ExportJob creation requires snapshot APPROVED; check in locked transaction.
-- * Conversation active-generation uniqueness is enforced by index above; retirement
--   must happen before retry insertion in a single database transaction.
-- * For immediate response correction, conversation-context status is separate from approval.


-- Phase 2D static design corrections; must be migration/integration tested.
ALTER TABLE "MemoryProposal" ADD CONSTRAINT "proposal_version_positive" CHECK ("version" > 0);
ALTER TABLE "UserAccount" ADD CONSTRAINT "preferences_version_positive" CHECK ("preferencesVersion" > 0);
ALTER TABLE "Conversation" ADD CONSTRAINT "metadata_version_positive" CHECK ("metadataVersion" > 0);
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "idempotency_status_valid"
  CHECK ("status" IN ('IN_PROGRESS', 'SUCCEEDED', 'FAILED_REPLAYABLE'));
ALTER TABLE "UsageLedger" ADD CONSTRAINT "usage_reservation_valid"
  CHECK ("reservationState" IN ('RESERVED', 'SETTLED', 'RELEASED') AND "reservedUnits" >= 0 AND "measuredUnits" >= 0);


-- Final security/privacy design checks (unexecuted migration fragment).
ALTER TABLE "Idea" ADD CONSTRAINT "idea_context_epoch_nonnegative" CHECK ("contextEpoch" >= 0);
ALTER TABLE "WebhookInbox" ADD CONSTRAINT "webhook_attempts_nonnegative"
  CHECK ("leaseEpoch" >= 0 AND "executionAttempts" >= 0);
ALTER TABLE "DataOperation" ADD CONSTRAINT "deletion_scope_and_state"
  CHECK (("kind" = 'EXPORT'::"DataOperationKind" AND "deletionScopeKey" IS NULL AND "deletionState" IS NULL)
    OR ("kind" IN ('DELETE_IDEA'::"DataOperationKind", 'DELETE_ACCOUNT'::"DataOperationKind")
      AND "deletionScopeKey" IS NOT NULL AND "deletionState" IS NOT NULL));
-- Immutable guards authorize DELETE only through the validated purge role and scope.
-- Procedure DDL and exact runtime role grants must be generated/reviewed during implementation;
-- never grant API logins fl_purge_owner membership or use database-owner credentials at runtime.

ALTER TABLE "DataOperation" ADD CONSTRAINT "completed_deletion_has_receipt"
  CHECK ("kind" = 'EXPORT'::"DataOperationKind" OR "status" <> 'COMPLETED'::"DataOperationStatus"
    OR ("deletionState" = 'DELETED'::"DeletionState" AND "livePurgedAt" IS NOT NULL AND "receiptMirroredAt" IS NOT NULL));
ALTER TABLE "WebhookInbox" ADD CONSTRAINT "processed_webhook_has_time"
  CHECK ("status" NOT IN ('APPLIED'::"WebhookInboxStatus", 'IGNORED'::"WebhookInboxStatus") OR "processedAt" IS NOT NULL);


-- Phase3 approved-principle amendments; design fragments, not an applied migration.
ALTER TABLE "GenerationAttempt" ADD CONSTRAINT "orchestration_metadata_minimized"
  CHECK ("orchestrationMetadata" IS NULL OR
    (jsonb_typeof("orchestrationMetadata") = 'object'
      AND octet_length("orchestrationMetadata"::text) <= 4096));
ALTER TABLE "Message" ADD CONSTRAINT "assistant_v2_payload_shape"
  CHECK ("contentSchemaVersion" <> 2 OR
    ("role" = 'ASSISTANT'::"MessageRole"
      AND jsonb_typeof("content") = 'object'
      AND "content" ? 'text' AND jsonb_typeof("content"->'text') = 'string'
      AND "content" ? 'assistantContent' AND jsonb_typeof("content"->'assistantContent') = 'object'
      AND ("content"->'assistantContent') ? 'schemaVersion'
      AND "content"->'assistantContent'->>'schemaVersion' = '1'));
-- Full versioned JSON validation/field allowlist, matching strategy, evidence/proposal scope,
-- claim support, card count/variants and metadata immutability are application-use-case gates.
-- Version1 historical payloads are unchanged; unknown versions fail closed in reader/validator.

-- P4-B01/B02 approved design fragments only. Generate/review migrations; none executed.
-- Prisma owns the Learning unique key, marker, LearningEvidence PK/FKs/indexes.
-- Do not emit duplicate CREATE TABLE / FK DDL from this guard file.
ALTER TABLE "Experiment" ADD CONSTRAINT "experiment_plan_title_shape"
  CHECK (NOT ("plan" ? 'title') OR
    (jsonb_typeof("plan"->'title') = 'string'
      AND length("plan"->>'title') <= 200)) NOT VALID;
-- NOT VALID preserves unreviewed legacy rows; new writes still check the constraint.
-- Validate later only after data-shape review, without fabricating/backfilling titles.

CREATE OR REPLACE FUNCTION fl_learning_history_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $fl_learning$
BEGIN
  IF TG_OP = 'DELETE' AND public.fl_privacy_delete_authorized(OLD."ideaId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'learning history requires scoped privacy purge; ordinary update forbidden';
END $fl_learning$;
CREATE TRIGGER fl_learning_history_immutable
  BEFORE UPDATE OR DELETE ON "Learning"
  FOR EACH ROW EXECUTE FUNCTION fl_learning_history_guard();

CREATE OR REPLACE FUNCTION fl_learning_evidence_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $fl_learning_evidence$
DECLARE captured boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public.fl_privacy_delete_authorized(OLD."ideaId") THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'learning evidence requires scoped privacy purge';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'captured learning evidence cannot be rewritten';
  END IF;
  SELECT l."evidenceLinksRecorded" INTO captured FROM public."Learning" l
    WHERE l."id" = NEW."learningId" AND l."ideaId" = NEW."ideaId" FOR UPDATE;
  IF NOT FOUND OR NOT captured THEN
    RAISE EXCEPTION 'learning evidence capture marker required';
  END IF;
  IF (SELECT count(*) FROM public."LearningEvidence" e WHERE e."learningId" = NEW."learningId") >= 20 THEN
    RAISE EXCEPTION 'learning evidence capture limit exceeded';
  END IF;
  RETURN NEW;
END $fl_learning_evidence$;
CREATE TRIGGER fl_learning_evidence_capture_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "LearningEvidence"
  FOR EACH ROW EXECUTE FUNCTION fl_learning_evidence_guard();
-- Service must insert true + the complete distinct set in the original create transaction only.
-- These guards prove neither founder authorization nor initial-transaction-only INSERT permission.
-- No late association insertion port/API exists; test the trusted create service and SQL role grants.
-- Legacy false remains immutable; no automatic false->true backfill or true->false reset.
-- Purge role/operation/idea locks stay live while deleting LearningEvidence, then its parents.
