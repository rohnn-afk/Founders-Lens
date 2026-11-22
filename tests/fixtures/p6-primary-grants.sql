-- Apply only to the fresh P6 primary after the reviewed baseline migration.
-- The bootstrap process creates the two logins with independent credentials.
REVOKE CONNECT, TEMPORARY ON DATABASE founders_lens_p6_local, postgres, template1 FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE founders_lens_p6_local TO fl_p6_workspace, fl_p6_provision;
GRANT USAGE ON SCHEMA public TO fl_p6_workspace, fl_p6_provision;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO fl_p6_workspace;

GRANT SELECT (id,status,"clerkSubject","clerkInstanceId","subjectKey","subjectKeyVersion")
  ON "UserAccount" TO fl_p6_workspace, fl_p6_provision;
GRANT SELECT (id,kind,"clerkInstanceId","ownerSubjectKey","subjectKeyVersion","ideaId")
  ON "DataOperation" TO fl_p6_workspace, fl_p6_provision;
GRANT SELECT (id,"clerkInstanceId","subjectKey","subjectKeyVersion")
  ON "IdentityTombstone" TO fl_p6_workspace, fl_p6_provision;
GRANT SELECT (id,"ownerId",status,title,summary,version,"createdAt","updatedAt")
  ON "Idea" TO fl_p6_workspace;

-- PostgreSQL requires an UPDATE column grant for SELECT FOR UPDATE.
-- updatedAt permits the locks without granting lifecycle, identity or content updates.
GRANT UPDATE ("updatedAt") ON "UserAccount", "Idea" TO fl_p6_workspace;

-- One-shot provisioning only. Existing account lookup may run, but rotation and
-- content mutations are outside this role's grants.
GRANT INSERT (id,"clerkSubject","clerkInstanceId","subjectKey","subjectKeyVersion","updatedAt")
  ON "UserAccount" TO fl_p6_provision;
