-- Local P6 fixture only. The operator provisions a separate login with no role memberships.
GRANT CONNECT ON DATABASE founders_lens_p6_local TO fl_idea_edit;
GRANT USAGE ON SCHEMA public TO fl_idea_edit;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO fl_idea_edit;

GRANT SELECT (id,status,"clerkSubject","clerkInstanceId","subjectKey","subjectKeyVersion")
  ON "UserAccount" TO fl_idea_edit;
GRANT UPDATE ("updatedAt") ON "UserAccount" TO fl_idea_edit;
GRANT SELECT (id,kind,"clerkInstanceId","ownerSubjectKey","subjectKeyVersion","ideaId")
  ON "DataOperation" TO fl_idea_edit;
GRANT SELECT (id,"clerkInstanceId","subjectKey","subjectKeyVersion")
  ON "IdentityTombstone" TO fl_idea_edit;
GRANT SELECT (id,"ownerId",status,title,summary,version,"createdAt","updatedAt") ON "Idea" TO fl_idea_edit;
GRANT UPDATE (title,summary,version,"updatedAt") ON "Idea" TO fl_idea_edit;
