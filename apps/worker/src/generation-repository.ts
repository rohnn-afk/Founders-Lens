// PostgreSQL worker adapter. Short fenced transactions own generation state,
// response selection and settlement. Authority and fake execution stay outside.
import type { Pool, PoolClient } from 'pg';
import type { ProviderResult } from './founder-provider.js';
import { observedUsage, recordObservation } from './provider-accounting.js';
import type { OfflineAssistantContent } from './generation-context.js';

const claims = 2;
export type Scope = {
  id: string; accountId: string; ideaId: string; conversationId: string; triggerMessageId: string;
  instanceId: string; subjectKey: string; subjectKeyVersion: number; contextEpoch: number;
};
export type Lease = { epoch: number; remainingMs: number };
type State = {
  status: string; leaseEpoch: number; live: boolean; remainingMs: number;
  executionAttempts: number; contextEpoch: number | null; started: boolean; expired: boolean;
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

async function settle(operationType: string, tx: PoolClient, scope: Scope, usage: 'SETTLED' | 'RELEASED' | 'UNKNOWN',
  measured = 1, metered = false) {
  // A crash after the invocation marker can leave usage uncertain. Keep the
  // reservation open in that case, so quota is not accidentally restored.
  const { rows: [reservation] } = await tx.query<{ reservationState: string; reservedUnits: string; measuredUnits: string }>(
    `SELECT "reservationState","reservedUnits","measuredUnits" FROM "UsageLedger"
      WHERE "accountId"=$1 AND "reservationId"=$2
        AND (NOT $3::boolean OR ("operationType"=$4 AND unit='tokens')) FOR UPDATE`, [scope.accountId, scope.id, metered, operationType]);
  if (usage === 'SETTLED' && reservation?.reservationState === 'SETTLED' &&
    (metered || Number(reservation.reservedUnits) === 1) && Number(reservation.measuredUnits) === measured) return;
  if (!reservation || reservation.reservationState !== 'RESERVED' ||
    (metered ? Number(reservation.reservedUnits) < 1 : Number(reservation.reservedUnits) !== 1) ||
    Number(reservation.measuredUnits) !== 0) {
    throw new Error('Generation reservation unavailable');
  }
  if (usage === 'UNKNOWN') return;
  const result = await tx.query(`UPDATE "UsageLedger" SET "reservationState"=$3,"measuredUnits"=$4
    WHERE "accountId"=$1 AND "reservationId"=$2 AND "reservationState"='RESERVED'`,
  [scope.accountId, scope.id, usage, usage === 'SETTLED' ? measured : 0]);
  if (result.rowCount !== 1) throw new Error('Generation settlement unavailable');
}

/** Use single invocation for a run that cannot safely repeat an external side effect. */
export function generationRepository(pool: Pool, { singleInvocation = false, bindClaimant = false, metered = false, operationType = 'generation',
  oneInvocationReservation }: { singleInvocation?: boolean; bindClaimant?: boolean; metered?: boolean;
    operationType?: 'generation' | 'groq_free_evaluation'; oneInvocationReservation?: number } = {}) {
  if (metered && (!singleInvocation || !bindClaimant)) throw new Error('Metering requires a single claimant invocation');
  if (oneInvocationReservation !== undefined && (!metered || !Number.isSafeInteger(oneInvocationReservation) ||
    oneInvocationReservation < 1)) throw new Error('Invalid single-invocation budget');
  const usageFor = (tx: PoolClient, scope: Scope) => metered ? observedUsage(tx, scope.id) : knownUsage(tx, scope);
  const measuredUnits = (receipt: Awaited<ReturnType<typeof usageFor>>) =>
    receipt && 'totalTokens' in receipt ? receipt.totalTokens : 1;
  async function locked<T>(scope: Scope, action: (tx: PoolClient, state: State) => Promise<T>, claiming = false) {
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      // Every business writer takes the same root-to-leaf lock order.
      await tx.query('SELECT id FROM "UserAccount" WHERE id=$1 FOR UPDATE', [scope.accountId]);
      await tx.query('SELECT id FROM "Idea" WHERE id=$1 FOR UPDATE', [scope.ideaId]);
      await tx.query('SELECT id FROM "Conversation" WHERE id=$1 FOR UPDATE', [scope.conversationId]);
      const { rows: [state] } = await tx.query<State>(`SELECT status,"leaseEpoch","executionAttempts","contextEpoch",
        COALESCE("leaseUntil">clock_timestamp(),false) AS live, "dispatchAuthorizedAt" IS NOT NULL AS started,
        "deadlineAt"<=clock_timestamp() AS expired,
        greatest(0, least(2147483647, floor(extract(epoch FROM "deadlineAt"-clock_timestamp())*1000)))::int AS "remainingMs"
        FROM "GenerationAttempt" WHERE id=$1
        ${bindClaimant && !claiming ? 'AND "leaseClaimant"=session_user::text' : ''} FOR UPDATE`, [scope.id]);
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
    /** Terminalize expired attempts without opening context or provider access. */
    async expireMetered(id: string, approved: { accountId: string; conversationId: string }) {
      if (!metered) throw new Error('Metered recovery unavailable');
      const { rows: [scope] } = await pool.query<Scope>(scopeSql, [id]);
      if (!scope || scope.accountId !== approved.accountId || scope.conversationId !== approved.conversationId) return;
      return locked(scope, async (tx, state) => {
        if (!state.expired || state.live || !['PENDING', 'RUNNING', 'CANCEL_REQUESTED'].includes(state.status)) return;
        const receipt = await usageFor(tx, scope);
        if (receipt && !state.started) throw new Error('Inconsistent invocation receipt');
        await settle(operationType, tx, scope, receipt ? 'SETTLED' : state.started ? 'UNKNOWN' : 'RELEASED', measuredUnits(receipt), true);
        await tx.query(`UPDATE public."GenerationAttempt" SET status='FAILED',"completedAt"=clock_timestamp(),
          "leaseEpoch"="leaseEpoch"+1,"leaseUntil"=NULL,"errorCode"=$2 WHERE id=$1`,
        [id, state.started && !receipt ? 'PROVIDER_OUTCOME_UNKNOWN' : 'GENERATION_EXHAUSTED']);
      }, true);
    },
    readContext(scope: Scope, epoch: number, clearanceExpiry: number) {
      return locked(scope, async (tx, state) => {
        if (state.status !== 'RUNNING' || !state.live || !state.remainingMs || state.leaseEpoch !== epoch ||
          state.contextEpoch !== scope.contextEpoch || !await clearanceCurrent(tx, clearanceExpiry)) return;
        const { rows: [row] } = await tx.query<{ context: unknown }>(
          'SELECT m06_context.read_attempt($1,$2,$3,$4) AS context',
          [scope.id, epoch, scope.contextEpoch, clearanceExpiry]);
        return row?.context;
      });
    },
    claim(scope: Scope, recover: boolean, clearanceExpiry: number) {
      return locked(scope, async (tx, state) => {
        if (!['PENDING', 'RUNNING', 'CANCEL_REQUESTED'].includes(state.status)) {
          const receipt = recover && ['FAILED', 'CANCELLED'].includes(state.status)
            ? await usageFor(tx, scope) : undefined;
          if (receipt && await clearanceCurrent(tx, clearanceExpiry)) {
            await settle(operationType, tx, scope, 'SETTLED', measuredUnits(receipt), metered);
            if (!await clearanceCurrent(tx, clearanceExpiry)) throw new Error('Generation clearance expired');
          }
          return;
        }
        if (state.live || (state.status !== 'PENDING' && !recover)) return;
        if (!await clearanceCurrent(tx, clearanceExpiry)) return;
        const cancelled = state.status === 'CANCEL_REQUESTED';
        const receipt = state.started ? await usageFor(tx, scope) : undefined;
        // A durable result proves usage even if its response was lost. A
        // recovery does not invoke again merely to reconstruct that response.
        if (receipt || (singleInvocation && state.started) || cancelled || !state.remainingMs || state.executionAttempts >= claims ||
          (state.status === 'RUNNING' && state.contextEpoch !== scope.contextEpoch)) {
          await settle(operationType, tx, scope, receipt ? 'SETTLED' : state.started ? 'UNKNOWN' : 'RELEASED', measuredUnits(receipt), metered);
          const result = await tx.query(`UPDATE "GenerationAttempt" SET status=$2::"GenerationStatus","completedAt"=clock_timestamp(),
            "leaseEpoch"="leaseEpoch"+1,"leaseUntil"=NULL,"errorCode"=$3 WHERE id=$1
            AND clock_timestamp()<to_timestamp($4::double precision/1000)`,
          [scope.id, cancelled ? 'CANCELLED' : 'FAILED', cancelled ? null :
            singleInvocation && state.started && !receipt ? 'PROVIDER_OUTCOME_UNKNOWN' : 'GENERATION_EXHAUSTED', clearanceExpiry]);
          if (result.rowCount !== 1) throw new Error('Generation clearance expired');
          return;
        }
        // A restart can take an expired fake claim, but it cannot renew the
        // previous epoch or reset the durable execution budget.
        return (await tx.query<Lease>(`UPDATE "GenerationAttempt" SET status='RUNNING',
          "leaseEpoch"="leaseEpoch"+1,"executionAttempts"="executionAttempts"+1,
          "leaseUntil"=least("deadlineAt",clock_timestamp()+interval '5 seconds'),
          "lastHeartbeatAt"=clock_timestamp(),"startedAt"=COALESCE("startedAt",clock_timestamp()),"contextEpoch"=$2
          ${bindClaimant ? ',"leaseClaimant"=session_user::text' : ''}
          WHERE id=$1 AND "deadlineAt">clock_timestamp()
            AND clock_timestamp()<to_timestamp($4::double precision/1000)
          RETURNING "leaseEpoch" AS epoch,$3::int AS "remainingMs"`,
        [scope.id,scope.contextEpoch,state.remainingMs,clearanceExpiry])).rows[0];
      }, true);
    },
    recordUsage(scope: Scope, epoch: number, observation?: ProviderResult) {
      return locked(scope, async (tx, state) => {
        if (!state.live || !state.remainingMs || state.leaseEpoch !== epoch ||
          state.contextEpoch !== scope.contextEpoch) return false;
        if (metered) {
          const claimant = await tx.query(`SELECT id FROM "GenerationAttempt"
            WHERE id=$1 AND "leaseClaimant"=session_user::text AND "leaseEpoch"=$2
              AND "dispatchAuthorizedAt" IS NOT NULL AND "leaseUntil">clock_timestamp()`, [scope.id, epoch]);
          if (!claimant.rowCount || !observation?.usage || !await recordObservation(tx, scope.id, epoch, observation)) return false;
          await settle(operationType, tx, scope, 'SETTLED', observation.usage.totalTokens, true);
          return true;
        }
        const { rows: [row] } = await tx.query<{ recorded: boolean }>(
          'SELECT t02_receipts.record_usage($1,$2) AS recorded', [scope.id, epoch]);
        return row?.recorded === true;
      });
    },
    markInvocation(scope: Scope, epoch: number, clearanceExpiry: number) {
      return locked(scope, async (tx, state) => {
        if (state.status !== 'RUNNING' || !state.live || !state.remainingMs || (singleInvocation && state.started) ||
          state.leaseEpoch !== epoch || state.contextEpoch !== scope.contextEpoch) return false;
        // The account lock serializes this check with every approved generation
        // marker. Any prior marker consumes the cap even when no receipt exists.
        if (oneInvocationReservation !== undefined) {
          const { rows: [budget] } = await tx.query<{ permitted: boolean }>(`SELECT EXISTS (
            SELECT 1 FROM public."UsageLedger" WHERE "reservationId"=$1 AND "accountId"=$2
              AND unit='tokens' AND "operationType"=$4 AND "reservationState"='RESERVED'
              AND "reservedUnits"=$3 AND "measuredUnits"=0
          ) AND NOT EXISTS (
            SELECT 1 FROM public."GenerationAttempt" g JOIN public."Conversation" c ON c.id=g."conversationId"
            JOIN public."Idea" i ON i.id=c."ideaId"
            WHERE i."ownerId"=$2 AND g."dispatchAuthorizedAt" IS NOT NULL
              AND ($4='generation' OR EXISTS (SELECT 1 FROM public."UsageLedger" u
                WHERE u."reservationId"=g.id AND u."accountId"=$2 AND u."operationType"=$4 AND u.unit='tokens'))
          ) AS permitted`, [scope.id, scope.accountId, oneInvocationReservation, operationType]);
          if (budget?.permitted !== true) return false;
        }
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
    finish(scope: Scope, epoch: number,
      completion: { id: string; text: string; assistantContent?: OfflineAssistantContent } | null, clearanceExpiry: number) {
      return locked(scope, async (tx, state) => {
        if (state.leaseEpoch !== epoch || !state.live || state.contextEpoch !== scope.contextEpoch) return false;
        const cancelled = state.status === 'CANCEL_REQUESTED';
        if (!cancelled && (state.status !== 'RUNNING' || !state.remainingMs)) return false;
        if (!cancelled && !completion && !singleInvocation && state.executionAttempts < claims) {
          // Leave the lease recoverable after a fake-only failure.
          return false;
        }
        if (!await clearanceCurrent(tx, clearanceExpiry)) return false;
        const receipt = state.started ? await usageFor(tx, scope) : undefined;
        if (!cancelled && completion) {
          if (receipt?.leaseEpoch !== epoch) return false;
          const { rows: [row] } = await tx.query<{ sequence: number }>(`UPDATE "Conversation"
            SET "nextSequence"="nextSequence"+1 WHERE id=$1 RETURNING "nextSequence"-1 AS sequence`, [scope.conversationId]);
          if (!row) throw new Error('Generation sequence unavailable');
          const fields = [completion.id, scope.ideaId, scope.conversationId, row.sequence,
            { text: completion.text, ...(completion.assistantContent && { assistantContent: completion.assistantContent }) }, scope.id];
          if (completion.assistantContent) {
            await tx.query(`INSERT INTO "Message"
              (id,"ideaId","conversationId",sequence,role,content,"generationAttemptId","contentSchemaVersion")
              VALUES ($1,$2,$3,$4,'ASSISTANT',$5,$6,2)`, fields);
          } else {
            await tx.query(`INSERT INTO "Message" (id,"ideaId","conversationId",sequence,role,content,"generationAttemptId")
              VALUES ($1,$2,$3,$4,'ASSISTANT',$5,$6)`, fields);
          }
          // Replace selection only inside the successful result transaction.
          await tx.query(`UPDATE "GenerationAttempt" SET "selectedAt"=NULL
            WHERE "triggerMessageId"=$1 AND "conversationId"=$2 AND "selectedAt" IS NOT NULL`, [scope.triggerMessageId,scope.conversationId]);
        }
        await settle(operationType, tx, scope, receipt ? 'SETTLED' : state.started ? 'UNKNOWN' : 'RELEASED', measuredUnits(receipt), metered);
        const status = cancelled ? 'CANCELLED' : completion ? 'COMPLETED' : 'FAILED';
        const result = await tx.query(`UPDATE "GenerationAttempt" SET status=$2::"GenerationStatus","completedAt"=clock_timestamp(),
          "selectedAt"=CASE WHEN $2::"GenerationStatus"='COMPLETED' THEN clock_timestamp() END,
          "leaseUntil"=NULL,"errorCode"=$3 WHERE id=$1 AND "leaseUntil">clock_timestamp()
            AND ($2::"GenerationStatus"='CANCELLED' OR "deadlineAt">clock_timestamp())
            AND clock_timestamp()<to_timestamp($4::double precision/1000)`,
        [scope.id,status,status==='FAILED' ? singleInvocation && state.started && !receipt
          ? 'PROVIDER_OUTCOME_UNKNOWN' : 'FAKE_EXECUTION_FAILED' : null,clearanceExpiry]);
        if (result.rowCount !== 1) throw new Error('Generation fence expired');
        return true;
      });
    }
  };
}
export type Repository = ReturnType<typeof generationRepository>;
