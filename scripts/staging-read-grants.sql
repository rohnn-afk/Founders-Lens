-- Apply as the schema owner to a fresh founders_lens_staging primary.
-- The operator creates the two LOGIN roles with separate secrets beforehand.
BEGIN;
DO $guard$
BEGIN
  IF current_database() <> 'founders_lens_staging' THEN
    RAISE EXCEPTION 'Unexpected staging grant target';
  END IF;
END
$guard$;
REVOKE CONNECT, TEMPORARY ON DATABASE founders_lens_staging FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE founders_lens_staging TO fl_p6_workspace, fl_p8_conversations;
GRANT USAGE ON SCHEMA public TO fl_p6_workspace, fl_p8_conversations;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO fl_p6_workspace, fl_p8_conversations;

GRANT SELECT (id,status,"clerkSubject","clerkInstanceId","subjectKey","subjectKeyVersion")
  ON public."UserAccount" TO fl_p6_workspace, fl_p8_conversations;
GRANT SELECT (id,kind,"clerkInstanceId","ownerSubjectKey","subjectKeyVersion","ideaId")
  ON public."DataOperation" TO fl_p6_workspace, fl_p8_conversations;
GRANT SELECT (id,"clerkInstanceId","subjectKey","subjectKeyVersion")
  ON public."IdentityTombstone" TO fl_p6_workspace, fl_p8_conversations;
GRANT SELECT (id,"ownerId",status,title,summary,version,"createdAt","updatedAt")
  ON public."Idea" TO fl_p6_workspace, fl_p8_conversations;

-- Row locks require UPDATE on at least one column.
GRANT UPDATE ("updatedAt") ON public."UserAccount", public."Idea" TO fl_p6_workspace, fl_p8_conversations;
GRANT SELECT (id,"ideaId",title,status,"metadataVersion","proactiveResearch","createdAt","updatedAt"),
  UPDATE ("updatedAt") ON public."Conversation" TO fl_p8_conversations;
GRANT SELECT (id,"ideaId","conversationId",sequence,role,content,"contentSchemaVersion","generationAttemptId","createdAt")
  ON public."Message" TO fl_p8_conversations;
GRANT SELECT (id,"conversationId","triggerMessageId","selectedAt",status)
  ON public."GenerationAttempt" TO fl_p8_conversations;
COMMIT;
