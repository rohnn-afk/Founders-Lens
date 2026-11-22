-- P9 context grants are written by a trusted verifier after live authority I/O.
-- The worker can consume a grant through one bounded, authenticated projection.
ALTER TABLE public."GenerationAttempt" ADD COLUMN "leaseClaimant" varchar(63);
CREATE SCHEMA p9_context;
REVOKE ALL ON SCHEMA p9_context FROM PUBLIC;

CREATE TABLE p9_context.context_grant (
  attempt_id uuid PRIMARY KEY REFERENCES public."GenerationAttempt"(id) ON DELETE CASCADE,
  lease_epoch integer NOT NULL,
  context_epoch integer NOT NULL,
  valid_until timestamptz NOT NULL
);
REVOKE ALL ON p9_context.context_grant FROM PUBLIC;

CREATE FUNCTION p9_context.read_attempt(attempt uuid, lease integer, context_version integer)
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
    SELECT m.id,m.sequence,m.content,m."conversationId",m."ideaId"
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
    'previous',COALESCE(history.turns,'[]'::jsonb),'memory','[]'::jsonb)
  INTO result FROM eligible e
  CROSS JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('user',jsonb_build_object('id', u.id,
      'text',left(u.content->>'text',600),'truncated',length(u.content->>'text')>600))
      ORDER BY u.sequence) AS turns
    FROM (SELECT m.id,m.sequence,m.content FROM public."Message" m
      WHERE m."conversationId"=e."conversationId" AND m."ideaId"=e."ideaId" AND m.role='USER'
        AND m.sequence<e.sequence ORDER BY m.sequence DESC LIMIT 3) u
  ) history;
  IF result IS NULL THEN RETURN NULL; END IF;
  -- A grant never authorizes another read. Check its deadline again after projection.
  DELETE FROM p9_context.context_grant
    WHERE attempt_id=attempt AND lease_epoch=lease AND context_epoch=context_version AND valid_until>clock_timestamp();
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION p9_context.read_attempt(uuid,integer,integer) FROM PUBLIC;
