-- Install only on an approved local primary after migrations 0002 and 0003.
-- Create fl_p9_submit, fl_p9_dispatch, fl_p9_worker and fl_p9_context_verifier as distinct
-- LOGIN NOINHERIT roles with operator-managed credentials before applying.
BEGIN;
DO $verify$
BEGIN
  IF current_database() NOT IN ('founders_lens_p6_local','founders_lens_m05_e2e_test','founders_lens_p9_local',
    'founders_lens_cedar_acceptance','founders_lens_cedar_recheck','founders_lens_offline_acceptance') THEN
    RAISE EXCEPTION 'Unexpected local generation target';
  END IF;
END
$verify$;

-- Submit and status share a login. This role can append new attempts but
-- cannot update one, provision accounts or associate a message with an answer attempt.
GRANT USAGE ON SCHEMA public TO fl_p9_submit;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO fl_p9_submit;
GRANT SELECT (id,"clerkSubject","clerkInstanceId","subjectKey","subjectKeyVersion",status), UPDATE ("updatedAt")
  ON public."UserAccount" TO fl_p9_submit;
GRANT SELECT (id,"ownerId",status), UPDATE ("updatedAt") ON public."Idea" TO fl_p9_submit;
-- Prisma updates updatedAt alongside the explicit sequence increment.
GRANT SELECT (id,"ideaId",status,"nextSequence"), UPDATE ("nextSequence","updatedAt")
  ON public."Conversation" TO fl_p9_submit;
GRANT SELECT (id,"clerkInstanceId","subjectKey","subjectKeyVersion") ON public."IdentityTombstone" TO fl_p9_submit;
GRANT SELECT (id,kind,"clerkInstanceId","ownerSubjectKey","subjectKeyVersion","ideaId")
  ON public."DataOperation" TO fl_p9_submit;
GRANT SELECT (id,"conversationId","triggerMessageId",status,"attemptNumber","selectedAt","createdAt",
  "startedAt","completedAt","errorCode"),
  INSERT (id,"conversationId","triggerMessageId","attemptNumber","createdAt","deadlineAt","orchestrationMetadata")
  ON public."GenerationAttempt" TO fl_p9_submit;
GRANT SELECT (id,"conversationId","ideaId",role,sequence,content,"generationAttemptId",
  "clientSubmissionKey","submissionSha256","contentSchemaVersion","createdAt"),
  INSERT (id,"conversationId","ideaId",role,sequence,content,"clientSubmissionKey","submissionSha256",
    "contentSchemaVersion","createdAt") ON public."Message" TO fl_p9_submit;
GRANT SELECT (id,"accountId","reservationState","reservedUnits","measuredUnits",unit,"operationType","occurredAt"),
  INSERT (id,"accountId","reservationId","reservationState","reservedUnits","measuredUnits",unit,
    "operationType",provider,"reconciliationKey","occurredAt") ON public."UsageLedger" TO fl_p9_submit;
GRANT SELECT, INSERT ON public."IdempotencyRecord" TO fl_p9_submit;
GRANT INSERT (id,kind,"aggregateType","aggregateId",payload,"createdAt","nextAttemptAt") ON public."OutboxEvent" TO fl_p9_submit;

GRANT USAGE ON SCHEMA public TO fl_p9_dispatch, fl_p9_worker, fl_p9_context_verifier;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO fl_p9_dispatch, fl_p9_worker, fl_p9_context_verifier;
GRANT SELECT (id,"clerkInstanceId","subjectKey","subjectKeyVersion",status)
  ON public."UserAccount" TO fl_p9_dispatch, fl_p9_worker;
GRANT SELECT (id,"ownerId",status) ON public."Idea" TO fl_p9_dispatch, fl_p9_worker;
GRANT SELECT (id,"ideaId",status) ON public."Conversation" TO fl_p9_dispatch, fl_p9_worker;
GRANT SELECT ("clerkInstanceId","subjectKey","subjectKeyVersion")
  ON public."IdentityTombstone" TO fl_p9_dispatch, fl_p9_worker;
GRANT SELECT (kind,"clerkInstanceId","ownerSubjectKey","subjectKeyVersion","ideaId")
  ON public."DataOperation" TO fl_p9_dispatch, fl_p9_worker;
GRANT SELECT (id,"conversationId","triggerMessageId",status,"deadlineAt")
  ON public."GenerationAttempt" TO fl_p9_dispatch, fl_p9_worker;
GRANT SELECT (id,kind,"aggregateType","aggregateId",payload,status,"claimEpoch","dispatchAttempts",
  "leaseUntil","nextAttemptAt","createdAt"),
  UPDATE (status,"claimEpoch","dispatchAttempts","leaseUntil","nextAttemptAt","publishedAt","lastErrorCode")
  ON public."OutboxEvent" TO fl_p9_dispatch;

-- The root timestamp privileges permit locking. Context content is visible
-- only through the function that enforces the session claimant and lease.
GRANT UPDATE ("updatedAt") ON public."UserAccount",public."Idea" TO fl_p9_worker;
GRANT SELECT ("contextEpoch") ON public."Idea" TO fl_p9_worker;
GRANT SELECT ("nextSequence"), UPDATE ("nextSequence") ON public."Conversation" TO fl_p9_worker;
GRANT SELECT ("contextEpoch","leaseEpoch","executionAttempts","leaseUntil","dispatchAuthorizedAt","startedAt","selectedAt","leaseClaimant"),
  UPDATE (status,"contextEpoch","leaseEpoch","executionAttempts","leaseUntil","lastHeartbeatAt",
    "dispatchAuthorizedAt","startedAt","selectedAt","completedAt","errorCode","leaseClaimant")
  ON public."GenerationAttempt" TO fl_p9_worker;
GRANT SELECT (id,"conversationId","ideaId",role),
  INSERT (id,"conversationId","ideaId",role,sequence,content,"generationAttemptId")
  ON public."Message" TO fl_p9_worker;
DO $$ BEGIN
  IF current_database() IN ('founders_lens_offline_acceptance', 'founders_lens_m05_e2e_test') THEN
    GRANT INSERT ("contentSchemaVersion") ON public."Message" TO fl_p9_worker;
  END IF;
END $$;
GRANT SELECT ("accountId","reservationId","reservationState","reservedUnits","measuredUnits",unit,"operationType"),
  UPDATE ("reservationState","measuredUnits") ON public."UsageLedger" TO fl_p9_worker;
GRANT SELECT, INSERT ON public."GenerationProviderReceipt" TO fl_p9_worker;
GRANT USAGE ON SCHEMA p9_context TO fl_p9_worker, fl_p9_context_verifier;
GRANT EXECUTE ON FUNCTION p9_context.read_attempt(uuid,integer,integer) TO fl_p9_worker;
GRANT SELECT, INSERT, UPDATE ON p9_context.context_grant TO fl_p9_context_verifier;
GRANT SELECT (id,"conversationId","triggerMessageId","orchestrationMetadata","deadlineAt",status,
  "leaseClaimant","leaseEpoch","contextEpoch","leaseUntil") ON public."GenerationAttempt" TO fl_p9_context_verifier;
GRANT SELECT (id,"clerkInstanceId","subjectKey","subjectKeyVersion",status) ON public."UserAccount" TO fl_p9_context_verifier;
GRANT SELECT (id,"ownerId",status) ON public."Idea" TO fl_p9_context_verifier;
GRANT SELECT (id,"ideaId",status) ON public."Conversation" TO fl_p9_context_verifier;
GRANT SELECT (id,"conversationId","ideaId",role) ON public."Message" TO fl_p9_context_verifier;
GRANT SELECT (kind,"accountId","clerkInstanceId","ownerSubjectKey","subjectKeyVersion","ideaId")
  ON public."DataOperation" TO fl_p9_context_verifier;
GRANT SELECT ("clerkInstanceId","subjectKey","subjectKeyVersion") ON public."IdentityTombstone" TO fl_p9_context_verifier;
COMMIT;
