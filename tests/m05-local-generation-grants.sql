-- Disposable E2E bootstrap only. The harness creates login roles first and
-- verifies this cluster contains exclusively its synthetic fixture.
BEGIN;
DO $verify$
BEGIN
  IF current_database() <> 'founders_lens_m05_e2e_test' OR
     NOT COALESCE(shobj_description(
       (SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database()),'pg_database')
       ~ '^isolated M05-E2E run [0-9a-f-]{36}$', false) THEN
    RAISE EXCEPTION 'Unexpected E2E grant target';
  END IF;
END
$verify$;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO fl_m05_t02_api,fl_m05_t02_worker,fl_m05_t02_fixture,fl_m05_e2e_dispatcher;
GRANT SELECT (id,"clerkInstanceId","subjectKey","subjectKeyVersion",status) ON "UserAccount"
  TO fl_m05_t02_api,fl_m05_t02_worker,fl_m05_e2e_dispatcher;
GRANT SELECT (id,"ownerId",status) ON "Idea" TO fl_m05_t02_api,fl_m05_t02_worker,fl_m05_e2e_dispatcher;
GRANT SELECT (id,"ideaId",status) ON "Conversation" TO fl_m05_t02_api,fl_m05_t02_worker,fl_m05_e2e_dispatcher;
GRANT SELECT (id,"clerkInstanceId","subjectKey","subjectKeyVersion") ON "IdentityTombstone"
  TO fl_m05_t02_api,fl_m05_t02_worker,fl_m05_e2e_dispatcher;
GRANT SELECT (id,kind,"clerkInstanceId","ownerSubjectKey","subjectKeyVersion","ideaId") ON "DataOperation"
  TO fl_m05_t02_api,fl_m05_t02_worker,fl_m05_e2e_dispatcher;
GRANT SELECT (id,"conversationId","triggerMessageId",status,"deadlineAt") ON "GenerationAttempt"
  TO fl_m05_t02_api,fl_m05_t02_worker,fl_m05_e2e_dispatcher;
GRANT SELECT (id,"conversationId","ideaId",role,sequence,"generationAttemptId") ON "Message"
  TO fl_m05_t02_api,fl_m05_t02_worker;
GRANT SELECT (id,"accountId","reservationId","reservationState","reservedUnits","measuredUnits",unit,"operationType")
  ON "UsageLedger" TO fl_m05_t02_api,fl_m05_t02_worker;

-- UPDATE permissions on the root timestamps enable row locks. Business writes
-- remain limited to the sequence, cancellation state and admission columns.
GRANT UPDATE ("updatedAt") ON "UserAccount","Idea" TO fl_m05_t02_api,fl_m05_t02_worker;
GRANT SELECT ("clerkSubject") ON "UserAccount" TO fl_m05_t02_api;
GRANT SELECT ("nextSequence"), UPDATE ("nextSequence") ON "Conversation" TO fl_m05_t02_api,fl_m05_t02_worker;
GRANT UPDATE ("updatedAt") ON "Conversation" TO fl_m05_t02_api;
GRANT SELECT (content,"clientSubmissionKey","submissionSha256","contentSchemaVersion","createdAt"),
  INSERT (id,"conversationId","ideaId",role,sequence,content,"clientSubmissionKey","submissionSha256","contentSchemaVersion","createdAt")
  ON "Message" TO fl_m05_t02_api;
GRANT SELECT ("attemptNumber","selectedAt","createdAt","startedAt","completedAt","errorCode"),
  INSERT (id,"conversationId","triggerMessageId","attemptNumber","createdAt","deadlineAt","regenerationKey"),
  UPDATE (status) ON "GenerationAttempt" TO fl_m05_t02_api;
GRANT INSERT (id,"accountId","reservationId","reservationState","reservedUnits","measuredUnits",unit,
  "operationType",provider,"reconciliationKey","occurredAt") ON "UsageLedger" TO fl_m05_t02_api;
GRANT SELECT, INSERT ON "IdempotencyRecord" TO fl_m05_t02_api;
GRANT INSERT (id,kind,"aggregateType","aggregateId",payload,"createdAt","nextAttemptAt") ON "OutboxEvent" TO fl_m05_t02_api;

GRANT SELECT ("contextEpoch") ON "Idea" TO fl_m05_t02_worker;
GRANT SELECT ("contextEpoch","leaseEpoch","executionAttempts","leaseUntil","dispatchAuthorizedAt","startedAt","selectedAt"),
  UPDATE (status,"contextEpoch","leaseEpoch","executionAttempts","leaseUntil","lastHeartbeatAt",
    "dispatchAuthorizedAt","startedAt","selectedAt","completedAt","errorCode")
  ON "GenerationAttempt" TO fl_m05_t02_worker;
GRANT INSERT (id,"conversationId","ideaId",role,sequence,content,"generationAttemptId") ON "Message" TO fl_m05_t02_worker;
GRANT UPDATE ("reservationState","measuredUnits") ON "UsageLedger" TO fl_m05_t02_worker;

GRANT SELECT (id,kind,"aggregateType","aggregateId",payload,status,"claimEpoch","dispatchAttempts",
  "leaseUntil","nextAttemptAt","createdAt"),
  UPDATE (status,"claimEpoch","dispatchAttempts","leaseUntil","nextAttemptAt","publishedAt","lastErrorCode")
  ON "OutboxEvent" TO fl_m05_e2e_dispatcher;

-- The fixture can seed roots and inject scoped races. Its observations never
-- include message bodies or orchestration metadata.
GRANT INSERT (id,"clerkSubject","clerkInstanceId","subjectKey","updatedAt") ON "UserAccount" TO fl_m05_t02_fixture;
GRANT INSERT (id,"ownerId",title,"updatedAt") ON "Idea" TO fl_m05_t02_fixture;
GRANT INSERT (id,"ideaId","updatedAt") ON "Conversation" TO fl_m05_t02_fixture;
GRANT SELECT (id) ON "UserAccount","Idea","Conversation" TO fl_m05_t02_fixture;
GRANT SELECT (id,role,"conversationId","generationAttemptId") ON "Message" TO fl_m05_t02_fixture;
GRANT SELECT (id,status,"leaseEpoch","leaseUntil","executionAttempts"), UPDATE ("leaseUntil")
  ON "GenerationAttempt" TO fl_m05_t02_fixture;
GRANT SELECT (id,status,"aggregateId","claimEpoch","dispatchAttempts","lastErrorCode"), UPDATE ("nextAttemptAt","leaseUntil")
  ON "OutboxEvent" TO fl_m05_t02_fixture;
GRANT SELECT (id,"reservationId","reservationState","measuredUnits") ON "UsageLedger" TO fl_m05_t02_fixture;
GRANT SELECT (id,"accountId") ON "IdempotencyRecord" TO fl_m05_t02_fixture;
GRANT SELECT (id), INSERT (id,"accountId","ideaId",kind,"deadlineAt","clerkInstanceId","ownerSubjectKey",
  "deletionScopeKey","deletionState","policyVersion") ON "DataOperation" TO fl_m05_t02_fixture;
GRANT DELETE ON "DataOperation" TO fl_m05_t02_fixture;
COMMIT;
