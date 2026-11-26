-- Preserve the existing one-use grant and project selected, same-epoch prior assistant text.
CREATE OR REPLACE FUNCTION p9_context.read_attempt(attempt uuid, lease integer, context_version integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE target record;
DECLARE result jsonb;
BEGIN
  -- Acquire the primary locks in generation order. Repeat all checks after waits.
  SELECT a.id AS account_id, i.id AS idea_id, c.id AS conversation_id
    INTO target
    FROM public."GenerationAttempt" g JOIN public."Conversation" c ON c.id=g."conversationId"
    JOIN public."Idea" i ON i.id=c."ideaId" JOIN public."UserAccount" a ON a.id=i."ownerId"
    WHERE g.id=attempt AND g."leaseClaimant"=session_user::text AND g."leaseEpoch"=lease;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM public."UserAccount" WHERE id=target.account_id FOR UPDATE;
  PERFORM 1 FROM public."Idea" WHERE id=target.idea_id FOR UPDATE;
  PERFORM 1 FROM public."Conversation" WHERE id=target.conversation_id FOR UPDATE;
  PERFORM 1 FROM public."GenerationAttempt" WHERE id=attempt FOR UPDATE;

  WITH eligible AS (
    SELECT m.id,m.sequence,m.content,m."conversationId",m."ideaId",i."contextEpoch"
    FROM public."GenerationAttempt" g
    JOIN p9_context.context_grant proof ON proof.attempt_id=g.id
    JOIN public."Conversation" c ON c.id=g."conversationId" AND c.id=target.conversation_id
    JOIN public."Idea" i ON i.id=c."ideaId" AND i.id=target.idea_id
    JOIN public."UserAccount" a ON a.id=i."ownerId" AND a.id=target.account_id
    JOIN public."Message" m ON m.id=g."triggerMessageId" AND m."conversationId"=c.id AND m."ideaId"=i.id
    WHERE g.id=attempt AND g."leaseClaimant"=session_user::text AND g."leaseEpoch"=lease
      AND proof.lease_epoch=lease AND proof.context_epoch=context_version
      AND g."contextEpoch"=context_version AND i."contextEpoch"=context_version
      AND g.status='RUNNING' AND g."leaseUntil">clock_timestamp() AND g."deadlineAt">clock_timestamp()
      AND proof.valid_until>clock_timestamp()
      AND a.status='ACTIVE' AND i.status='ACTIVE' AND c.status='ACTIVE' AND m.role='USER'
      AND NOT EXISTS (SELECT 1 FROM public."DataOperation" d WHERE
        (d.kind='DELETE_IDEA' AND d."ideaId"=i.id) OR
        (d.kind='DELETE_ACCOUNT' AND (d."accountId"=a.id OR
          (d."clerkInstanceId"=a."clerkInstanceId" AND d."ownerSubjectKey"=a."subjectKey"
            AND d."subjectKeyVersion"=a."subjectKeyVersion"))))
      AND NOT EXISTS (SELECT 1 FROM public."IdentityTombstone" t WHERE t."clerkInstanceId"=a."clerkInstanceId"
        AND t."subjectKey"=a."subjectKey" AND t."subjectKeyVersion"=a."subjectKeyVersion")
  )
  SELECT jsonb_build_object(
    'current',jsonb_build_object('id',e.id,'text',left(e.content->>'text',1200),
      'truncated',length(e.content->>'text')>1200),
    'previous',CASE WHEN EXISTS (
      SELECT 1 FROM public."ConfirmedMemory" m WHERE m."ideaId"=e."ideaId"
        AND (m.status='REMOVED' OR m."currentVersion">1)
    ) THEN '[]'::jsonb ELSE COALESCE(history.turns,'[]'::jsonb) END,'memory','[]'::jsonb)
  INTO result FROM eligible e
  CROSS JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('user',jsonb_build_object('id', u.id,
      'text',left(u.content->>'text',600),'truncated',length(u.content->>'text')>600)) ||
      CASE WHEN answer.id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('assistant',jsonb_build_object(
        'id',answer.id,'text',left(answer.content->>'text',600),
        'truncated',length(answer.content->>'text')>600)) END
      ORDER BY u.sequence) AS turns
    FROM (SELECT m.id,m.sequence,m.content FROM public."Message" m
      WHERE m."conversationId"=e."conversationId" AND m."ideaId"=e."ideaId" AND m.role='USER'
        AND m."contentSchemaVersion"=1 AND jsonb_typeof(m.content->'text')='string' AND length(m.content->>'text')>0
        AND m.sequence<e.sequence ORDER BY m.sequence DESC LIMIT 3) u
    -- A prior answer is conversational context only. Use the current selected
    -- output in this exact scope and epoch, and never read later turns.
    LEFT JOIN LATERAL (
      SELECT reply.id,reply.content FROM public."GenerationAttempt" prior
      JOIN public."Message" reply ON reply."generationAttemptId"=prior.id AND reply."ideaId"=e."ideaId"
        AND reply."conversationId"=e."conversationId"
      WHERE prior."triggerMessageId"=u.id AND prior."conversationId"=e."conversationId"
        AND prior.status='COMPLETED' AND prior."selectedAt" IS NOT NULL
        AND prior."contextEpoch"=e."contextEpoch" AND reply.role='ASSISTANT'
        AND reply."contentSchemaVersion" IN (1,2) AND jsonb_typeof(reply.content->'text')='string'
        AND length(reply.content->>'text')>0
        AND reply.sequence<e.sequence
      LIMIT 1
    ) answer ON true
  ) history;
  IF result IS NULL THEN RETURN NULL; END IF;
  -- A grant never authorizes another read. Check its deadline again after projection.
  DELETE FROM p9_context.context_grant
    WHERE attempt_id=attempt AND lease_epoch=lease AND context_epoch=context_version AND valid_until>clock_timestamp();
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION p9_context.read_attempt(uuid,integer,integer) FROM PUBLIC;
