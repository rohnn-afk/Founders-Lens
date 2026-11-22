// PostgreSQL adapter for the isolated Generation API. Locks stabilize owner
// scope and serialize replay, cancellation, and regeneration admission.
import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { lockWorkspaceAccount } from '../persistence/workspace-transaction.js';
import { SecurityError } from '../security/errors.js';
import type { Principal } from '../security/principal.js';
import { digest, SubmissionError } from '../submission/contracts.js';
import { generation, type Command, type CommandResult, type Generation } from './contracts.js';
import type { GenerationRepository, Scope } from './service.js';

type Tx = Prisma.TransactionClient;
type Policy = { operationType: string; unit: string; quotaUnits: number; deadlineMs: number; receiptTtlMs: number };
type Attempt = {
  id: string; conversationId: string; triggerMessageId: string; status: string;
  selectedAt: Date | null; startedAt: Date | null; completedAt: Date | null; createdAt: Date;
  errorCode: string | null; outputMessageId: string | null;
};
const missing = () => new SecurityError('RESOURCE_NOT_FOUND');
const unavailable = () => new SecurityError('DEPENDENCY_UNAVAILABLE');
const terminal = (status: string) => ['COMPLETED', 'FAILED', 'CANCELLED'].includes(status);

async function lockScope(tx: Tx, principal: Principal, scope: Scope, write: boolean) {
  await lockWorkspaceAccount(tx, principal);
  const [idea] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Idea" WHERE id=${scope.ideaId}::uuid AND "ownerId"=${principal.localUserId}::uuid
    AND (status='ACTIVE' OR (NOT ${write} AND status='ARCHIVED')) FOR UPDATE`;
  const [conversation] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Conversation" WHERE id=${scope.id}::uuid AND "ideaId"=${scope.ideaId}::uuid
    AND (status='ACTIVE' OR (NOT ${write} AND status='ARCHIVED')) FOR UPDATE`;
  if (!idea || !conversation || await tx.dataOperation.findFirst({ where: { kind: 'DELETE_IDEA', ideaId: scope.ideaId },
    select: { id: true } })) throw missing();
}

async function attempt(tx: Tx, scope: Scope, id: string, lock: boolean) {
  if (lock) await tx.$queryRaw`
    SELECT id FROM "GenerationAttempt" WHERE id=${id}::uuid AND "conversationId"=${scope.id}::uuid FOR UPDATE`;
  const [row] = await tx.$queryRaw<Attempt[]>`
    SELECT g.id,g."conversationId",g."triggerMessageId",g.status,g."selectedAt",g."createdAt",
      g."startedAt",g."completedAt",g."errorCode",m.id AS "outputMessageId"
    FROM "GenerationAttempt" g JOIN "Message" u ON u.id=g."triggerMessageId" AND u."conversationId"=g."conversationId"
      AND u."ideaId"=${scope.ideaId}::uuid AND u.role='USER'
    LEFT JOIN "Message" m ON m."generationAttemptId"=g.id AND m."conversationId"=g."conversationId"
      AND m."ideaId"=u."ideaId" AND m.role='ASSISTANT'
    WHERE g.id=${id}::uuid AND g."conversationId"=${scope.id}::uuid`;
  if (!row) throw missing();
  return row;
}

function project(row: Attempt): Generation {
  if ((row.status === 'COMPLETED') !== Boolean(row.outputMessageId)) throw unavailable();
  const { id, conversationId, triggerMessageId, status } = row;
  return generation.parse({ id, conversationId, triggerMessageId, status, selected: Boolean(row.selectedAt),
    createdAt: row.createdAt.toISOString(),
    ...(row.outputMessageId && { outputMessageId: row.outputMessageId }),
    ...(row.startedAt && { startedAt: row.startedAt.toISOString() }),
    ...(row.completedAt && { finishedAt: row.completedAt.toISOString() }),
    ...(status === 'FAILED' && { error: {
      code: row.errorCode === 'PROVIDER_OUTCOME_UNKNOWN' ? 'PROVIDER_OUTCOME_UNKNOWN' : 'GENERATION_FAILED',
      retryable: false
    } }) });
}

async function reserve(tx: Tx, account: string, id: string, policy: Policy, now: Date) {
  // Match M04 accounting under the same account lock. State alone cannot
  // grant capacity when the stored numeric values are inconsistent.
  const [quota] = await tx.$queryRaw<{ allowed: boolean; invalid: boolean }[]>`
    SELECT coalesce(sum(CASE "reservationState" WHEN 'RESERVED' THEN "reservedUnits"
      WHEN 'SETTLED' THEN "measuredUnits" ELSE 0 END),0)+1 <= ${policy.quotaUnits}::numeric AS allowed,
      coalesce(bool_or(NOT ("reservedUnits">=0 AND "reservedUnits"<'Infinity'::numeric
        AND "measuredUnits">=0 AND "measuredUnits"<'Infinity'::numeric
        AND ("reservationState"='SETTLED' OR ("reservationState" IN ('RESERVED','RELEASED') AND "measuredUnits"=0)))),false) AS invalid
    FROM "UsageLedger" WHERE "accountId"=${account}::uuid AND "operationType"=${policy.operationType} AND unit=${policy.unit}`;
  if (!quota || quota.invalid) throw unavailable();
  if (!quota.allowed) throw new SubmissionError('QUOTA_EXCEEDED');
  await tx.usageLedger.create({ data: { accountId: account, operationType: policy.operationType, unit: policy.unit,
    reservationId: id, reconciliationKey: 'regeneration:' + id, reservedUnits: 1, measuredUnits: 0, occurredAt: now },
  select: { id: true } });
}

async function regenerate(tx: Tx, account: string, scope: Scope, command: Extract<Command, { kind: 'regenerate' }>,
  policy: Policy, now: Date): Promise<Generation> {
  const [latest] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Message" WHERE "conversationId"=${scope.id}::uuid AND "ideaId"=${scope.ideaId}::uuid
    AND role='USER' ORDER BY sequence DESC LIMIT 1`;
  if (!latest || latest.id !== command.triggerMessageId) throw missing();
  const [attempts] = await tx.$queryRaw<{ active: boolean; last: number }[]>`
    SELECT coalesce(bool_or(status IN ('PENDING','RUNNING','CANCEL_REQUESTED')),false) AS active,
      coalesce(max("attemptNumber") FILTER (WHERE "triggerMessageId"=${latest.id}::uuid),0) AS last
    FROM "GenerationAttempt" WHERE "conversationId"=${scope.id}::uuid`;
  if (attempts?.active) throw new SubmissionError('GENERATION_IN_PROGRESS');
  if (!attempts?.last) throw missing();
  const id = randomUUID();
  await reserve(tx, account, id, policy, now);
  // Explicit columns keep SQL within the isolated role's grants, while
  // PostgreSQL supplies the defaults for worker-owned fencing fields.
  const deadline = new Date(now.getTime() + policy.deadlineMs);
  await tx.$executeRaw`INSERT INTO "GenerationAttempt"
    (id,"conversationId","triggerMessageId","attemptNumber","regenerationKey","createdAt","deadlineAt")
    VALUES (${id}::uuid,${scope.id}::uuid,${latest.id}::uuid,${attempts.last + 1},${command.key},${now},${deadline})`;
  await tx.$executeRaw`INSERT INTO "OutboxEvent"
    (id,kind,"aggregateType","aggregateId",payload,"createdAt","nextAttemptAt")
    VALUES (${randomUUID()}::uuid,'generation.requested','GenerationAttempt',${id}::uuid,
      ${JSON.stringify({ generationId: id })}::jsonb,${now},${now})`;
  return project(await attempt(tx, scope, id, false));
}

export function createGenerationRepository(client: PrismaClient, policy: Policy): GenerationRepository {
  if (![policy.quotaUnits, policy.receiptTtlMs, policy.deadlineMs].every(n => Number.isSafeInteger(n) && n > 0)
    || !/^[a-z][a-z0-9_]{0,59}$/.test(policy.operationType) || !/^[a-z][a-z0-9_]{0,39}$/.test(policy.unit)) throw unavailable();
  const admission = Object.freeze({ ...policy });

  async function transaction<T>(action: (tx: Tx) => Promise<T>) {
    try { return await client.$transaction(action); }
    catch (error) {
      if (error instanceof SecurityError || error instanceof SubmissionError) throw error;
      throw unavailable();
    }
  }

  return {
    async scope(principal, target, isAttempt) {
      try {
        const id = isAttempt ? (await client.generationAttempt.findUnique({ where: { id: target },
          select: { conversationId: true } }))?.conversationId : target;
        if (!id) return null;
        return await client.conversation.findFirst({ where: { id, idea: { ownerId: principal.localUserId } },
          select: { id: true, ideaId: true, idea: { select: { id: true, ownerId: true, status: true } } } });
      } catch { throw unavailable(); }
    },
    status(principal, scope, id, requireFresh) {
      return transaction(async tx => {
        await lockScope(tx, principal, scope, false);
        requireFresh?.();
        return project(await attempt(tx, scope, id, false));
      });
    },
    command(principal, scope, command) {
      return transaction(async tx => {
        await lockScope(tx, principal, scope, true);
        const row = command.kind === 'cancel' ? await attempt(tx, scope, command.target, true) : null;
        const receiptKey = { accountId: principal.localUserId, targetScope: command.target, key: command.key,
          operationType: command.kind === 'cancel' ? 'postGenerationsGenerationIdCancel' : 'postConversationsConversationIdRegenerations' };
        const fingerprint = digest(JSON.stringify([receiptKey.operationType, command.target,
          command.kind === 'regenerate' ? command.triggerMessageId : null]));
        const receipt = await tx.idempotencyRecord.findUnique({ where: { accountId_operationType_targetScope_key: receiptKey },
          select: { requestFingerprint: true, algorithmVersion: true, responseStatus: true, responseRef: true, status: true } });
        // Store the original accepted DTO; recomputing it after a worker
        // transition could change the outcome of the same command.
        if (receipt) {
          if (receipt.algorithmVersion !== 1 || receipt.status !== 'SUCCEEDED') throw unavailable();
          if (receipt.requestFingerprint !== fingerprint) throw new SubmissionError('IDEMPOTENCY_KEY_REUSED');
          const body = generation.parse(receipt.responseRef);
          const status = receipt.responseStatus;
          if (body.conversationId !== scope.id || (command.kind === 'cancel' && body.id !== command.target) ||
            (command.kind === 'regenerate' && (status !== 202 || body.status !== 'PENDING' ||
              body.triggerMessageId !== command.triggerMessageId)) ||
            (command.kind === 'cancel' && !(status === 202 && body.status === 'CANCEL_REQUESTED') &&
              !(status === 200 && terminal(body.status))) || (status !== 200 && status !== 202)) throw unavailable();
          return { status, body };
        }
        const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
        if (!clock) throw unavailable();
        let result: CommandResult;
        if (command.kind === 'regenerate') {
          result = { status: 202, body: await regenerate(tx, principal.localUserId, scope, command, admission, clock.now) };
        } else {
          if (!row) throw missing();
          if (row.status === 'PENDING' || row.status === 'RUNNING') {
            // The same attempt lock also guards worker finalization: the
            // first committed transition wins this race.
            await tx.generationAttempt.update({ where: { id: row.id }, data: { status: 'CANCEL_REQUESTED' },
              select: { id: true } });
            row.status = 'CANCEL_REQUESTED';
          }
          result = { status: terminal(row.status) ? 200 : 202, body: project(row) };
        }
        await tx.idempotencyRecord.create({ data: { ...receiptKey, requestFingerprint: fingerprint,
          status: 'SUCCEEDED', responseStatus: result.status, responseRef: JSON.parse(JSON.stringify(result.body)),
          createdAt: clock.now, expiresAt: new Date(clock.now.getTime() + admission.receiptTtlMs) }, select: { id: true } });
        return result;
      });
    }
  };
}
