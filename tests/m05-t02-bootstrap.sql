-- Isolated PostgreSQL 17 T02 bootstrap, run as the bootstrap administrator
-- after the approved baseline and three restricted roles exist. Run with
-- psql -X -v ON_ERROR_STOP=1 -f tests/m05-t02-bootstrap.sql. Existing objects
-- deliberately cause the transaction to fail instead of changing their ACLs.
BEGIN;
DO $verify$
BEGIN
  IF NOT COALESCE((
    SELECT (datname='founders_lens_m05_t02_test' AND shobj_description(oid,'pg_database') =
        'isolated M05-T02 run c4493052-1f5e-4060-8e40-700e374c3946')
      OR (datname='founders_lens_m05_e2e_test' AND shobj_description(oid,'pg_database') ~
        '^isolated M05-E2E run [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    FROM pg_catalog.pg_database WHERE datname=current_database()
  ), false) THEN
    RAISE EXCEPTION 'Unexpected T02 database';
  END IF;
END
$verify$;

CREATE ROLE fl_m05_t02_receipt_owner NOLOGIN NOINHERIT;
CREATE SCHEMA t02_receipts AUTHORIZATION fl_m05_t02_receipt_owner;
REVOKE ALL ON SCHEMA t02_receipts FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO fl_m05_t02_receipt_owner;
GRANT SELECT (id,"clerkInstanceId","subjectKey","subjectKeyVersion",status), UPDATE ("updatedAt") ON public."UserAccount" TO fl_m05_t02_receipt_owner;
GRANT SELECT (id,"ownerId",status,"contextEpoch"), UPDATE ("updatedAt") ON public."Idea" TO fl_m05_t02_receipt_owner;
GRANT SELECT (id,"ideaId",status), UPDATE ("updatedAt") ON public."Conversation" TO fl_m05_t02_receipt_owner;
GRANT SELECT (id,"conversationId","triggerMessageId",status,"leaseEpoch","leaseUntil","deadlineAt","contextEpoch","dispatchAuthorizedAt",provider,"orchestrationMetadata"),
  UPDATE ("orchestrationMetadata") ON public."GenerationAttempt" TO fl_m05_t02_receipt_owner;
GRANT SELECT (id,"conversationId","ideaId",role) ON public."Message" TO fl_m05_t02_receipt_owner;
GRANT SELECT ("clerkInstanceId","subjectKey","subjectKeyVersion") ON public."IdentityTombstone" TO fl_m05_t02_receipt_owner;
GRANT SELECT ("clerkInstanceId","ownerSubjectKey","subjectKeyVersion",kind,"ideaId") ON public."DataOperation" TO fl_m05_t02_receipt_owner;

SET LOCAL ROLE fl_m05_t02_receipt_owner;
CREATE FUNCTION t02_receipts.read_usage(attempt_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE owner_id uuid; idea_id uuid; conversation_id uuid; receipt jsonb; recorded_epoch integer; current_epoch integer;
BEGIN
  SELECT a.id,i.id,c.id INTO owner_id,idea_id,conversation_id
    FROM public."GenerationAttempt" g JOIN public."Conversation" c ON c.id=g."conversationId"
    JOIN public."Idea" i ON i.id=c."ideaId" JOIN public."UserAccount" a ON a.id=i."ownerId"
    WHERE g.id=attempt_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM public."UserAccount" a WHERE a.id=owner_id AND a.status='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM public."Idea" i WHERE i.id=idea_id AND i."ownerId"=owner_id AND i.status='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM public."Conversation" c WHERE c.id=conversation_id AND c."ideaId"=idea_id AND c.status='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT g."orchestrationMetadata"->'syntheticUsageReceipt',g."leaseEpoch" INTO receipt,current_epoch
    FROM public."GenerationAttempt" g JOIN public."Message" m ON m.id=g."triggerMessageId"
    JOIN public."UserAccount" a ON a.id=owner_id
    WHERE g.id=attempt_id AND g."conversationId"=conversation_id AND g.provider IS NULL
      AND m."conversationId"=conversation_id AND m."ideaId"=idea_id AND m.role='USER'
      AND g.status IN ('RUNNING','CANCEL_REQUESTED','FAILED','CANCELLED','COMPLETED')
      AND NOT EXISTS (SELECT 1 FROM public."IdentityTombstone" t WHERE t."clerkInstanceId"=a."clerkInstanceId"
        AND t."subjectKey"=a."subjectKey" AND t."subjectKeyVersion"=a."subjectKeyVersion")
      AND NOT EXISTS (SELECT 1 FROM public."DataOperation" d WHERE
        (d.kind='DELETE_IDEA' AND d."ideaId"=idea_id) OR
        (d.kind='DELETE_ACCOUNT' AND d."clerkInstanceId"=a."clerkInstanceId" AND d."ownerSubjectKey"=a."subjectKey"
          AND d."subjectKeyVersion"=a."subjectKeyVersion"))
    FOR UPDATE OF g;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF receipt IS NULL THEN RETURN '{}'::jsonb; END IF;
  IF jsonb_typeof(receipt) IS DISTINCT FROM 'object' OR
     jsonb_typeof(receipt->'leaseEpoch') IS DISTINCT FROM 'number' OR
     COALESCE(receipt->>'leaseEpoch','') !~ '^[1-9][0-9]{0,8}$' THEN
    RAISE EXCEPTION 'Invalid synthetic usage receipt' USING ERRCODE='22023';
  END IF;
  recorded_epoch := (receipt->>'leaseEpoch')::integer;
  IF recorded_epoch > current_epoch OR receipt <> jsonb_build_object('version',1,'generationId',attempt_id,
       'leaseEpoch',recorded_epoch,'measuredUnits',1,'completion','SUCCEEDED') THEN
    RAISE EXCEPTION 'Invalid synthetic usage receipt' USING ERRCODE='22023';
  END IF;
  RETURN receipt;
END
$function$;

CREATE FUNCTION t02_receipts.record_usage(attempt_id uuid, expected_epoch integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE existing jsonb; expected jsonb;
BEGIN
  IF attempt_id IS NULL OR expected_epoch IS NULL OR expected_epoch NOT BETWEEN 1 AND 999999999 THEN RETURN false; END IF;
  existing := t02_receipts.read_usage(attempt_id);
  IF existing IS NULL THEN RETURN false; END IF;
  expected := jsonb_build_object('version',1,'generationId',attempt_id,'leaseEpoch',expected_epoch,
    'measuredUnits',1,'completion','SUCCEEDED');
  PERFORM 1 FROM public."GenerationAttempt" g
    JOIN public."Conversation" c ON c.id=g."conversationId" JOIN public."Idea" i ON i.id=c."ideaId"
    WHERE g.id=attempt_id AND g."leaseEpoch"=expected_epoch AND g.status IN ('RUNNING','CANCEL_REQUESTED')
      AND g."contextEpoch"=i."contextEpoch" AND g."dispatchAuthorizedAt" IS NOT NULL
      AND g."leaseUntil">clock_timestamp() AND g."deadlineAt">clock_timestamp();
  IF NOT FOUND THEN RETURN false; END IF;
  IF existing=expected THEN RETURN true; END IF;
  IF existing<>'{}'::jsonb THEN RAISE EXCEPTION 'Conflicting synthetic usage receipt' USING ERRCODE='22023'; END IF;
  UPDATE public."GenerationAttempt"
    SET "orchestrationMetadata"=jsonb_set(COALESCE("orchestrationMetadata",'{}'::jsonb),'{syntheticUsageReceipt}',expected)
    WHERE id=attempt_id AND "leaseEpoch"=expected_epoch AND "leaseUntil">clock_timestamp() AND "deadlineAt">clock_timestamp();
  RETURN FOUND;
END
$function$;

-- Expose booleans only, and accept only exact fixture IDs. Neither the key
-- nor its value comes from the caller, so this cannot inspect sibling data.
CREATE FUNCTION t02_receipts.fixture_sibling(attempt_id uuid, account_id uuid, seed boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $fixture$
DECLARE metadata jsonb;
BEGIN
  IF seed IS NULL THEN RETURN false; END IF;
  SELECT g."orchestrationMetadata" INTO metadata
    FROM public."GenerationAttempt" g
    JOIN public."Conversation" c ON c.id=g."conversationId"
    JOIN public."Idea" i ON i.id=c."ideaId"
    JOIN public."UserAccount" a ON a.id=i."ownerId"
    JOIN public."Message" m ON m.id=g."triggerMessageId"
    WHERE g.id=attempt_id AND a.id=account_id
      AND a."clerkInstanceId"='m05-t02-fixture' AND a."subjectKeyVersion"=1
      AND a."subjectKey"=encode(sha256(convert_to('fixture-'||a.id::text,'UTF8')),'hex')
      AND a.status='ACTIVE' AND i.status='ACTIVE' AND c.status='ACTIVE'
      AND m.role='USER' AND m."conversationId"=c.id AND m."ideaId"=i.id
      AND g.provider IS NULL AND (NOT seed OR (g.status='PENDING' AND g."leaseEpoch"=0))
    FOR UPDATE OF a,i,c,g;
  IF NOT FOUND THEN RETURN false; END IF;
  IF seed THEN
    IF metadata IS NOT NULL AND metadata <> '{}'::jsonb THEN RETURN false; END IF;
    UPDATE public."GenerationAttempt"
      SET "orchestrationMetadata"=jsonb_build_object('fixtureSibling',jsonb_build_object('sentinel',17))
      WHERE id=attempt_id;
    RETURN FOUND;
  END IF;
  RETURN COALESCE(metadata-'syntheticUsageReceipt'='{"fixtureSibling":{"sentinel":17}}'::jsonb
    AND jsonb_typeof(metadata->'syntheticUsageReceipt')='object',false);
END
$fixture$;

REVOKE ALL ON FUNCTION t02_receipts.read_usage(uuid),t02_receipts.record_usage(uuid,integer),
  t02_receipts.fixture_sibling(uuid,uuid,boolean) FROM PUBLIC;
GRANT USAGE ON SCHEMA t02_receipts TO fl_m05_t02_worker,fl_m05_t02_fixture;
GRANT EXECUTE ON FUNCTION t02_receipts.read_usage(uuid),t02_receipts.record_usage(uuid,integer) TO fl_m05_t02_worker;
GRANT EXECUTE ON FUNCTION t02_receipts.fixture_sibling(uuid,uuid,boolean) TO fl_m05_t02_fixture;
RESET ROLE;
COMMIT;
