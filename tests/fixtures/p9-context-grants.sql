-- Apply after creating these dedicated, non-inheriting logins with local secrets.
GRANT USAGE ON SCHEMA p9_context TO fl_p9_context, fl_p9_context_verifier;
GRANT USAGE ON SCHEMA public TO fl_p9_context_verifier;
GRANT EXECUTE ON FUNCTION p9_context.read_attempt(uuid,integer,integer) TO fl_p9_context;
GRANT SELECT, INSERT, UPDATE ON p9_context.context_grant TO fl_p9_context_verifier;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO fl_p9_context_verifier;
GRANT SELECT (id,"conversationId","triggerMessageId","orchestrationMetadata","deadlineAt",status,
  "leaseClaimant","leaseEpoch","contextEpoch","leaseUntil")
  ON public."GenerationAttempt" TO fl_p9_context_verifier;
GRANT SELECT (id,"clerkInstanceId","subjectKey","subjectKeyVersion",status) ON public."UserAccount" TO fl_p9_context_verifier;
GRANT SELECT (id,"ownerId",status) ON public."Idea" TO fl_p9_context_verifier;
GRANT SELECT (id,"ideaId",status) ON public."Conversation" TO fl_p9_context_verifier;
GRANT SELECT (id,"conversationId","ideaId",role) ON public."Message" TO fl_p9_context_verifier;
GRANT SELECT (kind,"accountId","clerkInstanceId","ownerSubjectKey","subjectKeyVersion","ideaId")
  ON public."DataOperation" TO fl_p9_context_verifier;
GRANT SELECT ("clerkInstanceId","subjectKey","subjectKeyVersion") ON public."IdentityTombstone" TO fl_p9_context_verifier;
