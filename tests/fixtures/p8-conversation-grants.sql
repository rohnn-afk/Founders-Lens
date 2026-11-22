-- Local conversation role. Account and idea UPDATE grants permit row locks.
GRANT CONNECT ON DATABASE founders_lens_p6_local TO fl_p8_conversations;
GRANT USAGE ON SCHEMA public TO fl_p8_conversations;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO fl_p8_conversations;
GRANT SELECT (id,status,"clerkSubject","clerkInstanceId","subjectKey","subjectKeyVersion") ON "UserAccount" TO fl_p8_conversations;
GRANT UPDATE ("updatedAt") ON "UserAccount" TO fl_p8_conversations;
GRANT SELECT (id,kind,"clerkInstanceId","ownerSubjectKey","subjectKeyVersion","ideaId") ON "DataOperation" TO fl_p8_conversations;
GRANT SELECT (id,"clerkInstanceId","subjectKey","subjectKeyVersion") ON "IdentityTombstone" TO fl_p8_conversations;
GRANT SELECT (id,"ownerId",status,title,summary,version,"createdAt","updatedAt") ON "Idea" TO fl_p8_conversations;
GRANT UPDATE ("updatedAt") ON "Idea" TO fl_p8_conversations;

GRANT SELECT (id,"ideaId",title,status,"metadataVersion","proactiveResearch","nextSequence","createdAt","updatedAt")
  ON "Conversation" TO fl_p8_conversations;
GRANT INSERT (id,"ideaId",title,status,"metadataVersion","proactiveResearch","nextSequence","createdAt","updatedAt")
  ON "Conversation" TO fl_p8_conversations;
GRANT UPDATE ("nextSequence","updatedAt") ON "Conversation" TO fl_p8_conversations;

GRANT SELECT (id,"ideaId","conversationId",sequence,role,content,"contentSchemaVersion","clientSubmissionKey",
  "submissionSha256","generationAttemptId","createdAt") ON "Message" TO fl_p8_conversations;
GRANT INSERT (id,"ideaId","conversationId",sequence,role,content,"clientSubmissionKey","submissionSha256","createdAt")
  ON "Message" TO fl_p8_conversations;
-- The transcript v1 join reads selected attempts. The role cannot write attempts.
GRANT SELECT (id,"conversationId","triggerMessageId","selectedAt",status) ON "GenerationAttempt" TO fl_p8_conversations;
GRANT SELECT (id,"accountId","operationType","targetScope",key,"requestFingerprint","algorithmVersion",status,
  "responseStatus","responseRef") ON "IdempotencyRecord" TO fl_p8_conversations;
GRANT INSERT (id,"accountId","operationType","targetScope",key,"requestFingerprint","algorithmVersion",status,
  "responseStatus","responseRef","createdAt","expiresAt") ON "IdempotencyRecord" TO fl_p8_conversations;
