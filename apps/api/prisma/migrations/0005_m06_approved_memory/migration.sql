-- An explicitly enabled offline reader extends the existing one-use grant.
CREATE FUNCTION p9_context.read_with_approved_memory(attempt uuid, lease integer, context_version integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE base jsonb;
DECLARE approved jsonb;
DECLARE lineage jsonb;
DECLARE evidence_deadline timestamptz;
BEGIN
  SELECT valid_until INTO evidence_deadline FROM p9_context.context_grant
    WHERE attempt_id=attempt AND lease_epoch=lease AND context_epoch=context_version;
  IF evidence_deadline IS NULL OR evidence_deadline<=clock_timestamp() THEN RETURN NULL; END IF;
  base := p9_context.read_attempt(attempt, lease, context_version);
  IF base IS NULL THEN RETURN NULL; END IF;
  -- The grant reader holds the account, idea, conversation and attempt locks
  -- for this transaction. Approval and removal must serialize on the idea.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', selected.id, 'version', selected.version, 'text', left(selected.body,400),
      'truncated', length(selected.body)>400) ORDER BY selected.id), '[]'::jsonb),
    COALESCE(jsonb_agg(jsonb_build_object(
      'memoryId', selected.id, 'revisionId', selected.revision, 'version', selected.version,
      'proposalId', selected.proposal, 'sourceMessageId', selected.source) ORDER BY selected.id), '[]'::jsonb)
  INTO approved, lineage
  FROM (
    SELECT m.id,r.version,r.id AS revision,p.id AS proposal,s.id AS source,r.content->>'text' AS body
    FROM public."GenerationAttempt" g
    JOIN public."Conversation" c ON c.id=g."conversationId"
    JOIN public."Idea" i ON i.id=c."ideaId"
    JOIN public."ConfirmedMemory" m ON m."ideaId"=i.id AND m.status='ACTIVE'
    JOIN public."MemoryRevision" r ON r."memoryId"=m.id AND r.version=m."currentVersion"
      AND r."actorId"=i."ownerId" AND r.content=m."currentContent"
    JOIN LATERAL (
      SELECT p.id,p."sourceMessageId" FROM public."MemoryProposal" p
      WHERE p."ideaId"=i.id AND p."resultMemoryId"=m.id AND p."reviewedById"=i."ownerId"
        AND p.status IN ('ACCEPTED','EDITED_AND_ACCEPTED') AND p."reviewedAt" IS NOT NULL
        AND r.provenance->>'proposalId'=p.id::text
      ORDER BY p.id LIMIT 1
    ) p ON true
    JOIN public."Message" s ON s.id=p."sourceMessageId" AND s."ideaId"=i.id AND s.role='USER'
    JOIN public."Conversation" sc ON sc.id=s."conversationId" AND sc."ideaId"=i.id AND sc.status='ACTIVE'
    WHERE g.id=attempt AND jsonb_typeof(r.content->'text')='string'
      AND length(r.content->>'text')>0
    ORDER BY m.id LIMIT 3
  ) selected;
  UPDATE public."GenerationAttempt" g
  SET "orchestrationMetadata" = jsonb_set(COALESCE(g."orchestrationMetadata",'{}'::jsonb),
      '{memoryLineage}',lineage,true)
  WHERE g.id=attempt AND g."leaseEpoch"=lease AND g."contextEpoch"=context_version
    AND g."leaseClaimant"=session_user::text AND g.status='RUNNING'
    AND g."leaseUntil">clock_timestamp() AND g."deadlineAt">clock_timestamp()
    AND evidence_deadline>clock_timestamp()
    AND (NOT COALESCE(g."orchestrationMetadata" ? 'memoryLineage',false)
      OR g."orchestrationMetadata"->'memoryLineage'=lineage);
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_set(base,'{memory}',approved,true);
END $$;

REVOKE ALL ON FUNCTION p9_context.read_with_approved_memory(uuid,integer,integer) FROM PUBLIC;
