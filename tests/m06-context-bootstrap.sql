-- Disposable M05/M06 integration database only. The worker may request an
-- attempt-scoped projection but cannot read transcript or memory tables directly.
BEGIN;
DO $guard$
BEGIN
  IF current_database() <> 'founders_lens_m05_e2e_test' OR NOT COALESCE(
    shobj_description((SELECT oid FROM pg_database WHERE datname=current_database()), 'pg_database')
      ~ '^isolated M05-E2E run [0-9a-f-]{36}$', false) THEN
    RAISE EXCEPTION 'M06 context bootstrap requires the isolated integration database';
  END IF;
END
$guard$;

CREATE ROLE fl_m06_context_owner NOLOGIN NOINHERIT;
CREATE SCHEMA m06_context;
REVOKE ALL ON SCHEMA m06_context FROM PUBLIC;
GRANT USAGE ON SCHEMA public, m06_context TO fl_m06_context_owner;
GRANT USAGE ON SCHEMA m06_context TO fl_m05_t02_worker;
GRANT SELECT (id,status,"clerkInstanceId","subjectKey","subjectKeyVersion"), UPDATE ("updatedAt")
  ON public."UserAccount" TO fl_m06_context_owner;
GRANT SELECT (id,status,"ownerId","contextEpoch"), UPDATE ("updatedAt")
  ON public."Idea" TO fl_m06_context_owner;
GRANT SELECT (id,status,"ideaId"), UPDATE ("updatedAt")
  ON public."Conversation" TO fl_m06_context_owner;
GRANT SELECT (id,status,"conversationId","triggerMessageId","leaseEpoch","contextEpoch","leaseUntil","deadlineAt","selectedAt"),
  UPDATE ("lastHeartbeatAt") ON public."GenerationAttempt" TO fl_m06_context_owner;
GRANT SELECT (id,role,sequence,"ideaId","conversationId","generationAttemptId","contentSchemaVersion",content)
  ON public."Message" TO fl_m06_context_owner;
GRANT SELECT ("clerkInstanceId","subjectKey","subjectKeyVersion")
  ON public."IdentityTombstone" TO fl_m06_context_owner;
GRANT SELECT (kind,"ideaId","clerkInstanceId","ownerSubjectKey","subjectKeyVersion")
  ON public."DataOperation" TO fl_m06_context_owner;
GRANT SELECT (id,"ideaId",status,"currentVersion","currentContent")
  ON public."ConfirmedMemory" TO fl_m06_context_owner;
GRANT SELECT ("memoryId",version,content,"actorId")
  ON public."MemoryRevision" TO fl_m06_context_owner;
GRANT INSERT (id,"ideaId",kind,"currentContent",status,"updatedAt")
  ON public."ConfirmedMemory" TO fl_m05_t02_fixture;
GRANT INSERT (id,"memoryId",version,content,"actorId")
  ON public."MemoryRevision" TO fl_m05_t02_fixture;
GRANT INSERT (id,"ideaId",kind,candidate) ON public."MemoryProposal" TO fl_m05_t02_fixture;

CREATE FUNCTION m06_context.read_attempt(attempt_id uuid, lease_epoch integer, context_epoch integer, expiry_ms bigint)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $context$
DECLARE
  account_id uuid;
  idea_id uuid;
  conversation_id uuid;
  anchor integer;
  valid_until timestamptz;
  current_source jsonb;
  previous_sources jsonb;
  memory_sources jsonb;
BEGIN
  SELECT a.id,i.id,c.id INTO account_id,idea_id,conversation_id
  FROM public."GenerationAttempt" g JOIN public."Conversation" c ON c.id=g."conversationId"
  JOIN public."Idea" i ON i.id=c."ideaId" JOIN public."UserAccount" a ON a.id=i."ownerId"
  WHERE g.id=attempt_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- Repeat the root-to-leaf fence even when invoked directly. PostgreSQL
  -- requires a column UPDATE grant for the locks, but this function writes nothing.
  PERFORM 1 FROM public."UserAccount" WHERE id=account_id FOR UPDATE;
  PERFORM 1 FROM public."Idea" WHERE id=idea_id FOR UPDATE;
  PERFORM 1 FROM public."Conversation" WHERE id=conversation_id FOR UPDATE;
  PERFORM 1 FROM public."GenerationAttempt" WHERE id=attempt_id FOR UPDATE;

  SELECT m.sequence,
    jsonb_build_object('id',m.id,'text',left(m.content->>'text',1200),'truncated',char_length(m.content->>'text')>1200),
    least(g."leaseUntil",g."deadlineAt",to_timestamp(expiry_ms::double precision/1000))
  INTO anchor,current_source,valid_until
  FROM public."GenerationAttempt" g JOIN public."Conversation" c ON c.id=g."conversationId"
  JOIN public."Idea" i ON i.id=c."ideaId" JOIN public."UserAccount" a ON a.id=i."ownerId"
  JOIN public."Message" m ON m.id=g."triggerMessageId" AND m."conversationId"=c.id AND m."ideaId"=i.id
  WHERE g.id=attempt_id AND c.id=conversation_id AND i.id=idea_id AND a.id=account_id
    AND expiry_ms IS NOT NULL AND g.status='RUNNING' AND g."leaseEpoch"=lease_epoch
    AND g."contextEpoch"=context_epoch AND i."contextEpoch"=context_epoch AND g."leaseUntil" IS NOT NULL
    AND a.status='ACTIVE' AND i.status='ACTIVE' AND c.status='ACTIVE'
    AND m.role='USER' AND m."contentSchemaVersion"=1 AND jsonb_typeof(m.content->'text')='string' AND length(m.content->>'text')>0
    AND NOT EXISTS (SELECT 1 FROM public."IdentityTombstone" t WHERE t."clerkInstanceId"=a."clerkInstanceId"
      AND t."subjectKey"=a."subjectKey" AND t."subjectKeyVersion"=a."subjectKeyVersion")
    AND NOT EXISTS (SELECT 1 FROM public."DataOperation" d WHERE
      (d.kind='DELETE_ACCOUNT' AND d."clerkInstanceId"=a."clerkInstanceId"
        AND d."ownerSubjectKey"=a."subjectKey" AND d."subjectKeyVersion"=a."subjectKeyVersion")
      OR (d.kind='DELETE_IDEA' AND d."ideaId"=i.id));
  IF NOT FOUND OR valid_until <= clock_timestamp() THEN RETURN NULL; END IF;

  -- Legacy assistant rows lack reliable memory lineage. After removal or a
  -- revision, omit the historical window instead of reintroducing old context.
  IF NOT EXISTS (SELECT 1 FROM public."ConfirmedMemory" m WHERE m."ideaId"=idea_id
    AND (m.status='REMOVED' OR m."currentVersion">1)) THEN
    SELECT jsonb_agg(jsonb_build_object(
      'user',jsonb_build_object('id',u.id,'text',left(u.content->>'text',600),'truncated',char_length(u.content->>'text')>600),
      'assistant',CASE WHEN a.id IS NOT NULL THEN jsonb_build_object(
        'id',a.id,'text',left(a.content->>'text',600),'truncated',char_length(a.content->>'text')>600) END
    ) ORDER BY u.sequence)
    INTO previous_sources
    FROM (SELECT m.id,m.sequence,m.content FROM public."Message" m
      WHERE m."conversationId"=conversation_id AND m."ideaId"=idea_id AND m.role='USER' AND m.sequence<anchor
        AND m."contentSchemaVersion"=1 AND jsonb_typeof(m.content->'text')='string' AND length(m.content->>'text')>0
      ORDER BY m.sequence DESC LIMIT 3) u
    LEFT JOIN public."GenerationAttempt" g ON g."triggerMessageId"=u.id AND g."conversationId"=conversation_id
      AND g.status='COMPLETED' AND g."selectedAt" IS NOT NULL
    LEFT JOIN public."Message" a ON a."generationAttemptId"=g.id AND a."conversationId"=conversation_id
      AND a."ideaId"=idea_id AND a.role='ASSISTANT' AND a."contentSchemaVersion"=1
      AND jsonb_typeof(a.content->'text')='string' AND length(a.content->>'text')>0;
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
    'id',m.id,'text',left(m.content->>'text',400),'truncated',char_length(m.content->>'text')>400,'version',m.version
  ) ORDER BY m.id) INTO memory_sources
  FROM (SELECT m.id,r.content,r.version FROM public."ConfirmedMemory" m
    JOIN public."MemoryRevision" r ON r."memoryId"=m.id AND r.version=m."currentVersion"
      AND r."actorId"=account_id AND r.content=m."currentContent"
    WHERE m."ideaId"=idea_id AND m.status='ACTIVE'
      AND jsonb_typeof(r.content->'text')='string' AND length(r.content->>'text')>0
    ORDER BY m.id LIMIT 3) m;

  IF valid_until <= clock_timestamp() THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('current',current_source,'previous',COALESCE(previous_sources,'[]'::jsonb),
    'memory',COALESCE(memory_sources,'[]'::jsonb));
END
$context$;
ALTER FUNCTION m06_context.read_attempt(uuid,integer,integer,bigint) OWNER TO fl_m06_context_owner;
REVOKE ALL ON FUNCTION m06_context.read_attempt(uuid,integer,integer,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION m06_context.read_attempt(uuid,integer,integer,bigint) TO fl_m05_t02_worker;
COMMIT;
