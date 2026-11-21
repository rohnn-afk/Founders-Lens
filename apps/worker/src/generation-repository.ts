// PostgreSQL worker adapter. Short fenced transactions own generation state,
// response selection and settlement. Authority and fake execution stay outside.
import type { Pool, PoolClient } from 'pg';

const claims = 2;
export type Scope = {
  id: string; accountId: string; ideaId: string; conversationId: string; triggerMessageId: string;
  instanceId: string; subjectKey: string; subjectKeyVersion: number; contextEpoch: number;
};
export type Lease = { epoch: number; remainingMs: number };
type State = {
  status: string; leaseEpoch: number; live: boolean; remainingMs: number;
  executionAttempts: number; contextEpoch: number | null; started: boolean;
};

async function clearanceCurrent(tx: PoolClient, expiry: number) {
  // PostgreSQL's wall clock, unlike now(), advances while row locks wait.
  const { rows: [evidence] } = await tx.query<{ current: boolean }>(
    'SELECT clock_timestamp()<to_timestamp($1::double precision/1000) AS current', [expiry]);
  return evidence?.current === true;
}

const scopeSql = `SELECT g.id, a.id AS "accountId", i.id AS "ideaId", c.id AS "conversationId",
  g."triggerMessageId", a."clerkInstanceId" AS "instanceId", a."subjectKey", a."subjectKeyVersion", i."contextEpoch"
  FROM "GenerationAttempt" g JOIN "Conversation" c ON c.id=g."conversationId"
  JOIN "Idea" i ON i.id=c."ideaId" JOIN "UserAccount" a ON a.id=i."ownerId"
  JOIN "Message" m ON m.id=g."triggerMessageId" AND m."ideaId"=i.id AND m."conversationId"=c.id
  WHERE g.id=$1 AND m.role='USER' AND a.status='ACTIVE' AND i.status='ACTIVE' AND c.status='ACTIVE'
  AND NOT EXISTS (SELECT 1 FROM "IdentityTombstone" t WHERE t."clerkInstanceId"=a."clerkInstanceId"
    AND t."subjectKey"=a."subjectKey" AND t."subjectKeyVersion"=a."subjectKeyVersion")
  AND NOT EXISTS (SELECT 1 FROM "DataOperation" d WHERE
    (d.kind='DELETE_ACCOUNT' AND d."clerkInstanceId"=a."clerkInstanceId"
      AND d."ownerSubjectKey"=a."subjectKey" AND d."subjectKeyVersion"=a."subjectKeyVersion")
    OR (d.kind='DELETE_IDEA' AND d."ideaId"=i.id))`;

async function knownUsage(tx: PoolClient, scope: Scope) {
  // The database validates the receipt, including its historical lease epoch,
  // and projects only that key. The worker cannot read the metadata column.
  const { rows: [row] } = await tx.query<{ receipt: { leaseEpoch?: number; measuredUnits?: number } | null }>(
    'SELECT t02_receipts.read_usage($1) AS receipt', [scope.id]);
  return row?.receipt?.measuredUnits === 1 ? row.receipt : undefined;
}

async function settle(tx: PoolClient, scope: Scope, usage: 'SETTLED' | 'RELEASED' | 'UNKNOWN') {
  // A crash after the invocation marker can leave usage uncertain. Keep the
  // reservation open in that case, so quota is not accidentally restored.
  const { rows: [reservation] } = await tx.query<{ reservationState: string; reservedUnits: string; measuredUnits: string }>(
    `SELECT "reservationState","reservedUnits","measuredUnits" FROM "UsageLedger"
      WHERE "accountId"=$1 AND "reservationId"=$2 FOR UPDATE`, [scope.accountId, scope.id]);
  if (usage === 'SETTLED' && reservation?.reservationState === 'SETTLED' &&
    Number(reservation.reservedUnits) === 1 && Number(reservation.measuredUnits) === 1) return;
  if (!reservation || reservation.reservationState !== 'RESERVED' ||
    Number(reservation.reservedUnits) !== 1 || Number(reservation.measuredUnits) !== 0) {
    throw new Error('Generation reservation unavailable');
  }
  if (usage === 'UNKNOWN') return;
  const result = await tx.query(`UPDATE "UsageLedger" SET "reservationState"=$3,"measuredUnits"=$4
    WHERE "accountId"=$1 AND "reservationId"=$2 AND "reservationState"='RESERVED'`,
  [scope.accountId, scope.id, usage, usage === 'SETTLED' ? 1 : 0]);
  if (result.rowCount !== 1) throw new Error('Generation settlement unavailable');
}

export function generationRepository(pool: Pool) {
  async function locked<T>(scope: Scope, action: (tx: PoolClient, state: State) => Promise<T>) {
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      // Every business writer takes the same root-to-leaf lock order.
      await tx.query('SELECT id FROM "UserAccount" WHERE id=$1 FOR UPDATE', [scope.accountId]);
      await tx.query('SELECT id FROM "Idea" WHERE id=$1 FOR UPDATE', [scope.ideaId]);
      await tx.query('SELECT id FROM "Conversation" WHERE id=$1 FOR UPDATE', [scope.conversationId]);
      const { rows: [state] } = await tx.query<State>(`SELECT status,"leaseEpoch","executionAttempts","contextEpoch",
        COALESCE("leaseUntil">clock_timestamp(),false) AS live, "dispatchAuthorizedAt" IS NOT NULL AS started,
        greatest(0, least(2147483647, floor(extract(epoch FROM "deadlineAt"-clock_timestamp())*1000)))::int AS "remainingMs"
        FROM "GenerationAttempt" WHERE id=$1 FOR UPDATE`, [scope.id]);
      const { rows: [current] } = await tx.query<Scope>(scopeSql, [scope.id]);
      const result = state && current && JSON.stringify(current) === JSON.stringify(scope)
        ? await action(tx, state) : undefined;
      await tx.query('COMMIT');
      return result;
    } catch {
      await tx.query('ROLLBACK').catch(() => {});
      throw new Error('Generation transaction unavailable');
    } finally { tx.release(); }
  }

  return {
    async scope(id: string) { return (await pool.query<Scope>(scopeSql, [id])).rows[0]; },
    claim(scope: Scope, recover: boolean, clearanceExpiry: number) {
      return locked(scope, async (tx, state) => {
        if (!['PENDING', 'RUNNING', 'CANCEL_REQUESTED'].includes(state.status)) {
          if (recover && ['FAILED', 'CANCELLED'].includes(state.status) &&
            await clearanceCurrent(tx, clearanceExpiry) && await knownUsage(tx, scope)) {
            await settle(tx, scope, 'SETTLED');
            if (!await clearanceCurrent(tx, clearanceExpiry)) throw new Error('Generation clearance expired');
          }
          return;
        }
        if (state.live || (state.status !== 'PENDING' && !recover)) return;
        if (!await clearanceCurrent(tx, clearanceExpiry)) return;
        const cancelled = state.status === 'CANCEL_REQUESTED';
        const receipt = state.started ? await knownUsage(tx, scope) : undefined;
        // A durable result proves usage even if its response was lost. A
        // recovery does not invoke again merely to reconstruct that response.
        if (receipt || cancelled || !state.remainingMs || state.executionAttempts >= claims ||
          (state.status === 'RUNNING' && state.contextEpoch !== scope.contextEpoch)) {
          await settle(tx, scope, receipt ? 'SETTLED' : state.started ? 'UNKNOWN' : 'RELEASED');
          const result = await tx.query(`UPDATE "GenerationAttempt" SET status=$2::"GenerationStatus","completedAt"=clock_timestamp(),
            "leaseEpoch"="leaseEpoch"+1,"leaseUntil"=NULL,"errorCode"=$3 WHERE id=$1
            AND clock_timestamp()<to_timestamp($4::double precision/1000)`,
          [scope.id, cancelled ? 'CANCELLED' : 'FAILED', cancelled ? null : 'GENERATION_EXHAUSTED', clearanceExpiry]);
          if (result.rowCount !== 1) throw new Error('Generation clearance expired');
          return;
        }
        // A restart can take an expired fake claim, but it cannot renew the
        // previous epoch or reset the durable execution budget.
        return (await tx.query<Lease>(`UPDATE "GenerationAttempt" SET status='RUNNING',
          "leaseEpoch"="leaseEpoch"+1,"executionAttempts"="executionAttempts"+1,
          "leaseUntil"=least("deadlineAt",clock_timestamp()+interval '5 seconds'),
          "lastHeartbeatAt"=clock_timestamp(),"startedAt"=COALESCE("startedAt",clock_timestamp()),"contextEpoch"=$2
          WHERE id=$1 AND "deadlineAt">clock_timestamp()
            AND clock_timestamp()<to_timestamp($4::double precision/1000)
          RETURNING "leaseEpoch" AS epoch,$3::int AS "remainingMs"`,
        [scope.id,scope.contextEpoch,state.remainingMs,clearanceExpiry])).rows[0];
      });
    },
    recordUsage(scope: Scope, epoch: number) {
      return locked(scope, async (tx, state) => {
        if (!state.live || !state.remainingMs || state.leaseEpoch !== epoch ||
          state.contextEpoch !== scope.contextEpoch) return false;
        const { rows: [row] } = await tx.query<{ recorded: boolean }>(
          'SELECT t02_receipts.record_usage($1,$2) AS recorded', [scope.id, epoch]);
        return row?.recorded === true;
      });
    },
    markInvocation(scope: Scope, epoch: number, clearanceExpiry: number) {
      return locked(scope, async (tx, state) => {
        if (state.status !== 'RUNNING' || !state.live || !state.remainingMs ||
          state.leaseEpoch !== epoch || state.contextEpoch !== scope.contextEpoch) return false;
        const result = await tx.query(`UPDATE "GenerationAttempt" SET "dispatchAuthorizedAt"=clock_timestamp()
          WHERE id=$1 AND "leaseUntil">clock_timestamp() AND "deadlineAt">clock_timestamp()
            AND clock_timestamp()<to_timestamp($2::double precision/1000)`, [scope.id,clearanceExpiry]);
        return result.rowCount === 1;
      });
    },
    heartbeat(scope: Scope, epoch: number) {
      return locked(scope, async (tx, state) => {
        if (state.status !== 'RUNNING' || !state.live || !state.remainingMs ||
          state.leaseEpoch !== epoch || state.contextEpoch !== scope.contextEpoch) return false;
        const result = await tx.query(`UPDATE "GenerationAttempt" SET "lastHeartbeatAt"=clock_timestamp(),
          "leaseUntil"=least("deadlineAt",clock_timestamp()+interval '5 seconds')
          WHERE id=$1 AND "leaseUntil">clock_timestamp() AND "deadlineAt">clock_timestamp()`, [scope.id]);
        return result.rowCount === 1;
      });
    },
    finish(scope: Scope, epoch: number, completion: { id: string; text: string } | null, clearanceExpiry: number) {
      return locked(scope, async (tx, state) => {
        if (state.leaseEpoch !== epoch || !state.live || state.contextEpoch !== scope.contextEpoch) return false;
        const cancelled = state.status === 'CANCEL_REQUESTED';
        if (!cancelled && (state.status !== 'RUNNING' || !state.remainingMs)) return false;
        if (!cancelled && !completion && state.executionAttempts < claims) {
          // Leave the lease recoverable after a fake-only failure.
          return false;
        }
        if (!await clearanceCurrent(tx, clearanceExpiry)) return false;
        const receipt = state.started ? await knownUsage(tx, scope) : undefined;
        if (!cancelled && completion) {
          if (receipt?.leaseEpoch !== epoch) return false;
          const { rows: [row] } = await tx.query<{ sequence: number }>(`UPDATE "Conversation"
            SET "nextSequence"="nextSequence"+1 WHERE id=$1 RETURNING "nextSequence"-1 AS sequence`, [scope.conversationId]);
          if (!row) throw new Error('Generation sequence unavailable');
          await tx.query(`INSERT INTO "Message" (id,"ideaId","conversationId",sequence,role,content,"generationAttemptId")
            VALUES ($1,$2,$3,$4,'ASSISTANT',$5,$6)`,
          [completion.id,scope.ideaId,scope.conversationId,row.sequence,{ text:completion.text },scope.id]);
          // Replace selection only inside the successful result transaction.
          await tx.query(`UPDATE "GenerationAttempt" SET "selectedAt"=NULL
            WHERE "triggerMessageId"=$1 AND "conversationId"=$2 AND "selectedAt" IS NOT NULL`, [scope.triggerMessageId,scope.conversationId]);
        }
        await settle(tx, scope, receipt ? 'SETTLED' : state.started ? 'UNKNOWN' : 'RELEASED');
        const status = cancelled ? 'CANCELLED' : completion ? 'COMPLETED' : 'FAILED';
        const result = await tx.query(`UPDATE "GenerationAttempt" SET status=$2::"GenerationStatus","completedAt"=clock_timestamp(),
          "selectedAt"=CASE WHEN $2::"GenerationStatus"='COMPLETED' THEN clock_timestamp() END,
          "leaseUntil"=NULL,"errorCode"=$3 WHERE id=$1 AND "leaseUntil">clock_timestamp()
            AND ($2::"GenerationStatus"='CANCELLED' OR "deadlineAt">clock_timestamp())
            AND clock_timestamp()<to_timestamp($4::double precision/1000)`,
        [scope.id,status,status==='FAILED'?'FAKE_EXECUTION_FAILED':null,clearanceExpiry]);
        if (result.rowCount !== 1) throw new Error('Generation fence expired');
        return true;
      });
    }
  };
}
export type Repository = ReturnType<typeof generationRepository>;
