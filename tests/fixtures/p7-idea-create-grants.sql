-- Apply to an independently provisioned local fl_p7_idea_create role.
-- This role has no membership in the P6 reader or provisioning roles.
GRANT CONNECT ON DATABASE founders_lens_p6_local TO fl_p7_idea_create;
GRANT USAGE ON SCHEMA public TO fl_p7_idea_create;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO fl_p7_idea_create;

GRANT SELECT (id,status,"clerkSubject","clerkInstanceId","subjectKey","subjectKeyVersion")
  ON "UserAccount" TO fl_p7_idea_create;
GRANT UPDATE ("updatedAt") ON "UserAccount" TO fl_p7_idea_create;
GRANT SELECT (id,kind,"clerkInstanceId","ownerSubjectKey","subjectKeyVersion","ideaId")
  ON "DataOperation" TO fl_p7_idea_create;
GRANT SELECT (id,"clerkInstanceId","subjectKey","subjectKeyVersion")
  ON "IdentityTombstone" TO fl_p7_idea_create;

-- Replay locks the existing idea and checks its lifecycle before disclosing the receipt.
GRANT SELECT (id,"ownerId",status,title,summary,version,"createdAt","updatedAt") ON "Idea" TO fl_p7_idea_create;
GRANT UPDATE ("updatedAt") ON "Idea" TO fl_p7_idea_create;
GRANT INSERT (id,"ownerId",title,summary,"contextEpoch",status,version,"createdAt","updatedAt")
  ON "Idea" TO fl_p7_idea_create;

-- Account, operation, target and key are fixed after insertion. Only expired
-- receipts can be replaced by the service under the account lock.
GRANT SELECT (id,"accountId","operationType","targetScope",key,"requestFingerprint","algorithmVersion",status,
  "responseStatus","responseRef","expiresAt") ON "IdempotencyRecord" TO fl_p7_idea_create;
GRANT INSERT (id,"accountId","operationType","targetScope",key,"requestFingerprint","algorithmVersion",status,
  "responseStatus","responseRef","createdAt","expiresAt") ON "IdempotencyRecord" TO fl_p7_idea_create;
GRANT UPDATE ("requestFingerprint","responseRef",status,"responseStatus","expiresAt")
  ON "IdempotencyRecord" TO fl_p7_idea_create;
