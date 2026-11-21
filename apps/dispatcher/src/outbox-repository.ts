// PostgreSQL adapter for the transactional outbox. It leases committed intents
// and fences delivery bookkeeping. Broker calls belong to the coordinator.
import type { Pool } from 'pg';
import { isUuid, policy } from './config.js';

export type Event = {
  id: string; kind: string; aggregateType: string; aggregateId: string;
  payload: unknown; claimEpoch: number; dispatchAttempts: number;
};
export type Scope = {
  accountId: string; ideaId: string; conversationId: string; instanceId: string;
  subjectKey: string; subjectKeyVersion: number; remainingMs: number;
};
export type Failure = 'INVALID_EVENT' | 'INELIGIBLE' | 'SUPPRESSION_UNAVAILABLE' |
  'BROKER_UNCERTAIN' | 'BROKER_MISMATCH' | 'DISPATCH_EXHAUSTED';
const eventFields = 'id, kind, "aggregateType", "aggregateId", payload, "claimEpoch", "dispatchAttempts"';
const due = `(("status" = 'PENDING' AND "nextAttemptAt" <= statement_timestamp())
 OR ("status" = 'CLAIMED' AND "leaseUntil" <= statement_timestamp()))`;
const fenced = `id = $1 AND status = 'CLAIMED' AND "claimEpoch" = $2 AND "leaseUntil" > clock_timestamp()`;
const deadline = (alias: string) => `${alias}."createdAt" + interval '${policy.windowMs} milliseconds' > clock_timestamp()`;
const lifecycle = `FROM "GenerationAttempt" g JOIN "Conversation" c ON c.id=g."conversationId"
  JOIN "Idea" i ON i.id=c."ideaId" JOIN "UserAccount" a ON a.id=i."ownerId"
  WHERE g.id=e."aggregateId" AND g.status='PENDING' AND c.status='ACTIVE' AND i.status='ACTIVE' AND a.status='ACTIVE'
  AND g."deadlineAt">clock_timestamp()
  AND NOT EXISTS (SELECT 1 FROM "IdentityTombstone" t WHERE t."clerkInstanceId"=a."clerkInstanceId"
    AND t."subjectKey"=a."subjectKey" AND t."subjectKeyVersion"=a."subjectKeyVersion")
  AND NOT EXISTS (SELECT 1 FROM "DataOperation" d WHERE d."clerkInstanceId"=a."clerkInstanceId"
    AND d.kind='DELETE_ACCOUNT' AND d."ownerSubjectKey"=a."subjectKey" AND d."subjectKeyVersion"=a."subjectKeyVersion")
  AND NOT EXISTS (SELECT 1 FROM "DataOperation" d WHERE d.kind='DELETE_IDEA' AND d."ideaId"=i.id)`;

export function outboxRepository(pool: Pool, fixtureIds: readonly string[]) {
  if (!fixtureIds.length || !fixtureIds.every(isUuid) || new Set(fixtureIds).size !== fixtureIds.length) {
    throw new Error('Exact M05 fixture IDs are required');
  }
  const ids = [...fixtureIds];
  function allowed(id: string) {
    if (!ids.includes(id)) throw new Error('Unknown M05 fixture');
  }

  return {
    assertFixtures(requested: readonly string[]) { requested.forEach(allowed); },
    async claim() {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // SKIP LOCKED lets other dispatchers take different rows. A lease
        // recovers claims abandoned after commit, and every claim costs an attempt.
        const selected = await client.query<{ id: string }>(`SELECT id FROM "OutboxEvent"
          WHERE id=ANY($1::uuid[]) AND ${due}
          ORDER BY "nextAttemptAt", id LIMIT $2 FOR UPDATE SKIP LOCKED`, [ids, policy.batch]);
        const selectedIds = selected.rows.map(row => row.id);
        const exhausted = await client.query<{ id: string }>(`UPDATE "OutboxEvent" e
          SET status='FAILED', "leaseUntil"=NULL, "lastErrorCode"='DISPATCH_EXHAUSTED'
          WHERE id=ANY($1::uuid[]) AND ("dispatchAttempts">=$2 OR NOT (${deadline('e')})
            OR EXISTS (SELECT 1 FROM "GenerationAttempt" g WHERE g.id=e."aggregateId" AND g."deadlineAt"<=clock_timestamp()))
          RETURNING id`, [selectedIds, policy.attempts]);
        const events = await client.query<Event>(`UPDATE "OutboxEvent"
          SET status='CLAIMED', "claimEpoch"="claimEpoch"+1, "dispatchAttempts"="dispatchAttempts"+1,
            "leaseUntil"=clock_timestamp()+interval '${policy.leaseMs} milliseconds'
          WHERE id=ANY($1::uuid[]) AND status<>'FAILED' RETURNING ${eventFields}`, [selectedIds]);
        await client.query('COMMIT');
        return { events: events.rows, exhausted: exhausted.rows.map(row => row.id) };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { client.release(); }
    },
    async published(id: string) {
      allowed(id);
      const result = await pool.query<Event>(`SELECT ${eventFields} FROM "OutboxEvent"
        WHERE id=$1 AND status='PUBLISHED' AND "dispatchAttempts"<$2`, [id, policy.attempts]);
      return result.rows[0];
    },
    async scope(event: Event, published = false) {
      allowed(event.id);
      const result = await pool.query<Scope>(`SELECT a.id AS "accountId", i.id AS "ideaId", c.id AS "conversationId",
        a."clerkInstanceId" AS "instanceId", a."subjectKey", a."subjectKeyVersion",
        floor(extract(epoch FROM (least(eligible.deadline,
          e."createdAt"+interval '${policy.windowMs} milliseconds',
          CASE WHEN NOT $3::boolean THEN e."leaseUntil" END) - clock_timestamp())) * 1000)::int AS "remainingMs"
        FROM "OutboxEvent" e JOIN LATERAL (SELECT g."deadlineAt" AS deadline, c.id AS conversation, i.id AS idea, a.id AS account
          ${lifecycle}) eligible ON true
        JOIN "Conversation" c ON c.id=eligible.conversation JOIN "Idea" i ON i.id=eligible.idea
        JOIN "UserAccount" a ON a.id=eligible.account
        WHERE e.id=$1 AND e."claimEpoch"=$2 AND ${deadline('e')} AND
          CASE WHEN $3::boolean THEN e.status='PUBLISHED'
            ELSE e.status='CLAIMED' AND e."leaseUntil">clock_timestamp() END`,
      [event.id, event.claimEpoch, published]);
      return result.rows[0];
    },
    async reclaimPublished(event: Event) {
      allowed(event.id);
      const result = await pool.query<Event>(`UPDATE "OutboxEvent" e
        SET status='CLAIMED', "claimEpoch"="claimEpoch"+1, "dispatchAttempts"="dispatchAttempts"+1,
          "leaseUntil"=clock_timestamp()+interval '${policy.leaseMs} milliseconds'
        WHERE id=$1 AND "claimEpoch"=$2 AND status='PUBLISHED' AND "dispatchAttempts"<$3
          AND ${deadline('e')} AND EXISTS (SELECT 1 ${lifecycle})
        RETURNING ${eventFields}`, [event.id, event.claimEpoch, policy.attempts]);
      return result.rows[0];
    },
    async acknowledge(event: Event) {
      allowed(event.id);
      // A delayed broker acknowledgement cannot overwrite a newer claimant.
      const result = await pool.query(`UPDATE "OutboxEvent" SET status='PUBLISHED', "publishedAt"=clock_timestamp(),
        "leaseUntil"=NULL, "lastErrorCode"=NULL WHERE ${fenced}`, [event.id, event.claimEpoch]);
      return result.rowCount === 1;
    },
    async fail(event: Event, code: Failure, delayMs: number, terminal = false) {
      allowed(event.id);
      // Keep poisoned or exhausted events for inspection instead of deleting intent.
      const result = await pool.query<{ status: 'FAILED' | 'PENDING' }>(`UPDATE "OutboxEvent" e
        SET status=CASE WHEN $3::boolean OR "dispatchAttempts">=$4
          OR "createdAt"+interval '${policy.windowMs} milliseconds'<=clock_timestamp()+$5::int*interval '1 millisecond'
          OR EXISTS (SELECT 1 FROM "GenerationAttempt" g WHERE g.id=e."aggregateId"
            AND g."deadlineAt"<=clock_timestamp()+$5::int*interval '1 millisecond')
          THEN 'FAILED'::"OutboxStatus" ELSE 'PENDING'::"OutboxStatus" END,
        "lastErrorCode"=$6, "leaseUntil"=NULL, "nextAttemptAt"=clock_timestamp()+$5::int*interval '1 millisecond'
        WHERE ${fenced} RETURNING status`, [event.id, event.claimEpoch, terminal, policy.attempts, delayMs, code]);
      return result.rows[0]?.status;
    }
  };
}
export type OutboxRepository = ReturnType<typeof outboxRepository>;
