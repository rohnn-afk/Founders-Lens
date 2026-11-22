// PostgreSQL submission repository. It locks the authorized scope, resolves
// replay, and commits every effect of a new submission in one transaction.
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { lockWorkspaceAccount } from '../persistence/workspace-transaction.js';
import { SecurityError } from '../security/errors.js';
import type { Principal } from '../security/principal.js';
import { acceptanceRef, fingerprintVersion, submissionOperation, SubmissionError, type AcceptanceRef } from './contracts.js';
import type { AdmissionPolicy, SubmissionCommand, SubmissionRepository, SubmissionScope, TranscriptRow } from './service.js';

type Tx = Prisma.TransactionClient;
type ReceiptKey = Prisma.IdempotencyRecordAccountIdOperationTypeTargetScopeKeyCompoundUniqueInput;

const unavailable = () => new SecurityError('DEPENDENCY_UNAVAILABLE');

function positiveInteger(value: number, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value > 0 && value <= max;
}
function verifiedPolicy(policy: AdmissionPolicy | undefined) {
  if (!policy || typeof policy.unit !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(policy.unit) ||
    typeof policy.operationType !== 'string' || !/^[a-z][a-z0-9_]{0,59}$/.test(policy.operationType) ||
    !positiveInteger(policy.quotaUnits, 99_999_999_999) || !positiveInteger(policy.reservationUnits, policy.quotaUnits) ||
    !positiveInteger(policy.deadlineMs) || !positiveInteger(policy.receiptTtlMs) ||
    (policy.requestsPerMinute !== undefined && !positiveInteger(policy.requestsPerMinute, 60)) ||
    (policy.maximumAdmissions !== undefined && !positiveInteger(policy.maximumAdmissions, 100)) ||
    (policy.currentTurnBytes !== undefined && !positiveInteger(policy.currentTurnBytes, 4096))) throw unavailable();
  return policy;
}
function atOffset(now: Date, milliseconds: number) {
  const date = new Date(now.getTime() + milliseconds);
  if (!Number.isFinite(date.getTime())) throw unavailable();
  return date;
}

async function lockSubmissionScope(tx: Tx, principal: Principal, command: SubmissionCommand) {
  await lockWorkspaceAccount(tx, principal);
  // Row locks keep lifecycle and sequence decisions stable until commit.
  // Take them in account, idea, conversation order, just like workspace writes.
  const ideas = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Idea" WHERE id = ${command.ideaId}::uuid AND "ownerId" = ${principal.localUserId}::uuid
    AND status = 'ACTIVE' FOR UPDATE`;
  if (!ideas.length) throw new SecurityError('RESOURCE_NOT_FOUND');
  if (await tx.dataOperation.findFirst({ where: { kind: 'DELETE_IDEA', ideaId: command.ideaId }, select: { id: true } })) {
    throw new SecurityError('RESOURCE_NOT_FOUND');
  }
  const conversations = await tx.$queryRaw<{ nextSequence: number }[]>`
    SELECT "nextSequence" FROM "Conversation" WHERE id = ${command.conversationId}::uuid
    AND "ideaId" = ${command.ideaId}::uuid AND status = 'ACTIVE' FOR UPDATE`;
  const conversation = conversations[0];
  if (!conversation) throw new SecurityError('RESOURCE_NOT_FOUND');
  return conversation.nextSequence;
}

async function saveReceipt(tx: Tx, scope: ReceiptKey, fingerprint: string, ref: AcceptanceRef, now: Date, ttl: number) {
  await tx.idempotencyRecord.create({ data: { ...scope, requestFingerprint: fingerprint,
    algorithmVersion: fingerprintVersion, status: 'SUCCEEDED', responseStatus: 202,
    responseRef: ref, createdAt: now, expiresAt: atOffset(now, ttl) }, select: { id: true } });
}

async function resolveReplay(tx: Tx, scope: ReceiptKey, command: SubmissionCommand, now: Date, policy?: AdmissionPolicy) {
  const receipt = await tx.idempotencyRecord.findUnique({ where: { accountId_operationType_targetScope_key: scope } });
  if (receipt) {
    if (receipt.algorithmVersion !== fingerprintVersion) throw unavailable();
    if (receipt.requestFingerprint !== command.fingerprint) throw new SubmissionError('IDEMPOTENCY_KEY_REUSED');
  }

  // Receipt expiration ends the short-lived replay lookup. The unique
  // conversation/submission pair still identifies the original USER message.
  const message = await tx.message.findUnique({ where: { conversationId_clientSubmissionKey: {
    conversationId: command.conversationId, clientSubmissionKey: command.body.clientSubmissionId
  } }, select: { id: true, ideaId: true, role: true, submissionSha256: true,
    triggeringAttempts: { where: { attemptNumber: 1 }, select: { id: true, conversationId: true } } } });
  if (!message) {
    if (receipt) throw unavailable();
    return undefined;
  }
  if (message.role !== 'USER' || message.ideaId !== command.ideaId || !message.submissionSha256) throw unavailable();
  if (message.submissionSha256 !== command.contentHash) {
    if (receipt) throw unavailable();
    throw new SubmissionError('CONFLICT');
  }
  const original = message.triggeringAttempts[0];
  if (message.triggeringAttempts.length !== 1 || !original || original.conversationId !== command.conversationId) throw unavailable();

  const ref = { messageId: message.id, generationId: original.id };
  if (receipt) {
    if (receipt.status !== 'SUCCEEDED' || receipt.responseStatus !== 202) throw unavailable();
    if (now < receipt.expiresAt) {
      const recorded = acceptanceRef.safeParse(receipt.responseRef);
      if (!recorded.success || recorded.data.messageId !== ref.messageId || recorded.data.generationId !== ref.generationId) throw unavailable();
      return recorded.data;
    }
    // Reconstruct from the durable records after expiry. Leave the expired
    // row in place so that its key cannot silently bind to different content.
    return ref;
  }
  await saveReceipt(tx, scope, command.fingerprint, ref, now, verifiedPolicy(policy).receiptTtlMs);
  return ref;
}

async function requireNewAdmission(tx: Tx, accountId: string, conversationId: string, policy: AdmissionPolicy) {
  const active = await tx.generationAttempt.findFirst({ where: { conversationId,
    status: { in: ['PENDING', 'RUNNING', 'CANCEL_REQUESTED'] } }, select: { id: true } });
  if (active) throw new SubmissionError('GENERATION_IN_PROGRESS');
  // All writers for this policy take the same account lock, even across
  // conversations. Otherwise concurrent sums can both spend the last unit.
  // An open reservation holds its original units until settlement. Settlement
  // counts actual usage, and release frees capacity only for zero measured usage.
  const [usage] = await tx.$queryRaw<{ consumed: Prisma.Decimal; inconsistent: boolean; recent: bigint; admissions: bigint }[]>`
    SELECT COALESCE(SUM(CASE WHEN valid THEN CASE "reservationState"
      WHEN 'RESERVED' THEN "reservedUnits" WHEN 'SETTLED' THEN "measuredUnits" ELSE 0 END END), 0) AS consumed,
      COALESCE(BOOL_OR(valid IS NOT TRUE), false) AS inconsistent, COUNT(*) AS admissions,
      ${policy.requestsPerMinute === undefined ? Prisma.sql`0::bigint`
        : Prisma.sql`COUNT(*) FILTER (WHERE "occurredAt" > clock_timestamp() - interval '1 minute')`} AS recent
    FROM (
      SELECT "reservationState", "reservedUnits", "measuredUnits",
        ${policy.requestsPerMinute === undefined ? Prisma.empty : Prisma.sql`"occurredAt",`}
        ("reservedUnits" >= 0 AND "reservedUnits" < 'Infinity'::numeric
          AND "measuredUnits" >= 0 AND "measuredUnits" < 'Infinity'::numeric
          AND ("reservationState" = 'SETTLED'
            OR ("reservationState" IN ('RESERVED', 'RELEASED') AND "measuredUnits" = 0))) AS valid
      FROM "UsageLedger"
      WHERE "accountId" = ${accountId}::uuid AND "operationType" = ${policy.operationType} AND unit = ${policy.unit}
    ) AS ledger`;
  if (!usage || usage.inconsistent) throw unavailable();
  if (policy.maximumAdmissions !== undefined && usage.admissions >= BigInt(policy.maximumAdmissions)) {
    throw new SubmissionError('QUOTA_EXCEEDED');
  }
  if (policy.requestsPerMinute !== undefined && usage.recent >= BigInt(policy.requestsPerMinute)) {
    throw new SubmissionError('QUOTA_EXCEEDED');
  }
  if (usage.consumed.plus(policy.reservationUnits).greaterThan(policy.quotaUnits)) throw new SubmissionError('QUOTA_EXCEEDED');
}

async function persistAcceptance(tx: Tx, scope: ReceiptKey, command: SubmissionCommand, sequence: number,
  now: Date, policy: AdmissionPolicy, principal: Principal) {
  const deadlineAt = atOffset(now, policy.deadlineMs);
  const ref = { messageId: randomUUID(), generationId: randomUUID() };
  // An atomic transaction commits these writes together. If the final outbox
  // write fails, rollback restores both the sequence and the reserved budget.
  await tx.conversation.update({ where: { id: command.conversationId }, data: { nextSequence: { increment: 1 } },
    select: { id: true } });
  await tx.message.create({ data: { id: ref.messageId, ideaId: command.ideaId, conversationId: command.conversationId,
    sequence, role: 'USER', content: { text: command.body.content }, contentSchemaVersion: 1,
    clientSubmissionKey: command.body.clientSubmissionId, submissionSha256: command.contentHash, createdAt: now },
  select: { id: true } });
  // Admission never reads private orchestration metadata or sets worker fences.
  if (command.executionDecision) {
    const { primaryTarget, authorityIdentity, namespace, recoveryRun } = command.executionDecision;
    // Check the identity of this transaction's connection, not just the operator's verifier pool.
    const [target] = await tx.$queryRaw<{ identity: string }[]>`
      SELECT system_identifier::text || ':' || d.oid::text AS identity
      FROM pg_catalog.pg_control_system(), pg_catalog.pg_database d WHERE d.datname=current_database()`;
    if (target?.identity !== primaryTarget) throw unavailable();
    // Persist references only. A worker must independently check live CLEAR for every version.
    const executionScope = { version: 1, primaryTarget, authorityIdentity, namespace, recoveryRun,
      accountId: scope.accountId, ideaId: command.ideaId, conversationId: command.conversationId,
      instanceId: principal.clerkInstanceId, ...ref,
      accountKeys: principal.subjectKeys.map(({ version, digest }) => ({ version, digest })).sort((a, b) => a.version - b.version) };
    await tx.$executeRaw`INSERT INTO "GenerationAttempt"
      (id,"triggerMessageId","conversationId","attemptNumber","createdAt","deadlineAt","orchestrationMetadata")
      VALUES (${ref.generationId}::uuid,${ref.messageId}::uuid,${command.conversationId}::uuid,1,${now},${deadlineAt},
        ${JSON.stringify({ executionScope })}::jsonb)`;
  } else {
    await tx.$executeRaw`INSERT INTO "GenerationAttempt"
      (id,"triggerMessageId","conversationId","attemptNumber","createdAt","deadlineAt")
      VALUES (${ref.generationId}::uuid,${ref.messageId}::uuid,${command.conversationId}::uuid,1,${now},${deadlineAt})`;
  }
  await tx.usageLedger.create({ data: { accountId: scope.accountId, operationType: policy.operationType, unit: policy.unit,
    reservationId: ref.generationId, reconciliationKey: 'message-submission:' + ref.generationId,
    reservationState: 'RESERVED', provider: null, reservedUnits: policy.reservationUnits, measuredUnits: 0, occurredAt: now },
  select: { id: true } });
  await saveReceipt(tx, scope, command.fingerprint, ref, now, policy.receiptTtlMs);
  // The outbox is a durable instruction for later delivery. Store IDs only,
  // so publishing later never requires keeping an extra copy of private text.
  await tx.$executeRaw`INSERT INTO "OutboxEvent"
    (id,kind,"aggregateType","aggregateId",payload,"createdAt","nextAttemptAt")
    VALUES (${randomUUID()}::uuid,${command.executionDecision ? 'p9.generation.requested' : 'generation.requested'},
      'GenerationAttempt',${ref.generationId}::uuid,
      ${JSON.stringify({ generationId: ref.generationId })}::jsonb,${now},${now})`;
  return ref;
}

export function createSubmissionRepository(client: PrismaClient): SubmissionRepository {
  async function read<T>(principal: Principal, scope: SubmissionScope, activeOnly: boolean,
    select: (tx: Tx) => Promise<T>, localReadGuard?: () => void): Promise<T> {
    try {
      return await client.$transaction(async tx => {
        // Match submission's lock order so lifecycle cannot change between
        // the local authorization recheck and the private projection.
        await lockWorkspaceAccount(tx, principal);
        const idea = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM "Idea" WHERE id = ${scope.ideaId}::uuid AND "ownerId" = ${principal.localUserId}::uuid
          AND (status = 'ACTIVE' OR (NOT ${activeOnly} AND status = 'ARCHIVED')) FOR SHARE`;
        if (!idea.length) throw new SecurityError('RESOURCE_NOT_FOUND');
        const conversation = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM "Conversation" WHERE id = ${scope.id}::uuid AND "ideaId" = ${scope.ideaId}::uuid
          AND (status = 'ACTIVE' OR (NOT ${Boolean(localReadGuard)} AND status = 'ARCHIVED')) FOR SHARE`;
        if (!conversation.length) throw new SecurityError('RESOURCE_NOT_FOUND');
        if (localReadGuard) {
          if (await tx.dataOperation.findFirst({ where: { kind: 'DELETE_IDEA', ideaId: scope.ideaId }, select: { id: true } })) {
            throw new SecurityError('RESOURCE_NOT_FOUND');
          }
          localReadGuard();
        }
        return select(tx);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError ||
        error instanceof Prisma.PrismaClientInitializationError) throw unavailable();
      throw error;
    }
  }

  return {
    scope(principal, conversationId) {
      return client.conversation.findFirst({ where: { id: conversationId, idea: { ownerId: principal.localUserId } },
        select: { id: true, ideaId: true, status: true, idea: { select: { id: true, ownerId: true, status: true } } } });
    },
    correlate(principal, scope, submissionId) {
      return read(principal, scope, true, async tx => {
        // A regenerated or selected answer does not change the attempt
        // originally created by acceptance. Read only that attempt's ID.
        const rows = await tx.$queryRaw<{ messageId: string; generationId: string | null }[]>`
          SELECT m.id AS "messageId", a.id AS "generationId" FROM "Message" m
          LEFT JOIN "GenerationAttempt" a ON a."triggerMessageId" = m.id
            AND a."conversationId" = m."conversationId" AND a."attemptNumber" = 1
          WHERE m."conversationId" = ${scope.id}::uuid AND m."ideaId" = ${scope.ideaId}::uuid
            AND m.role = 'USER' AND m."clientSubmissionKey" = ${submissionId}`;
        const row = rows[0];
        if (!row) return null;
        const result = acceptanceRef.safeParse(row);
        if (!result.success) throw new SubmissionError('PROJECTION_UNAVAILABLE');
        return result.data;
      });
    },
    history(principal, scope, limit, after, localReadGuard) {
      return read(principal, scope, Boolean(localReadGuard), tx => {
        const [turn, slot] = after ?? [0, 0];
        // Regenerated answers may be appended much later. Place the selected
        // answer immediately after its own USER turn, including across pages.
        return tx.$queryRaw<TranscriptRow[]>`
          SELECT m.id, m."conversationId", m.sequence, m.role::text AS role, m.content,
            m."contentSchemaVersion", m."createdAt", u.sequence AS turn, slots.slot
          FROM "Message" u
          LEFT JOIN "GenerationAttempt" a ON a."triggerMessageId" = u.id
            AND a."conversationId" = u."conversationId" AND a."selectedAt" IS NOT NULL AND a.status = 'COMPLETED'
          CROSS JOIN (VALUES (0), (1)) AS slots(slot)
          JOIN "Message" m ON m."conversationId" = u."conversationId" AND m."ideaId" = u."ideaId"
            AND ((slots.slot = 0 AND m.id = u.id)
              OR (slots.slot = 1 AND m."generationAttemptId" = a.id AND m.role = 'ASSISTANT'))
          WHERE u."conversationId" = ${scope.id}::uuid AND u."ideaId" = ${scope.ideaId}::uuid AND u.role = 'USER'
            AND (u.sequence, slots.slot) > (${turn}::int, ${slot}::int)
          ORDER BY u.sequence, slots.slot LIMIT ${limit}`;
      }, localReadGuard);
    },
    async accept(principal, command, clock, policy, requireFresh) {
      try {
        return await client.$transaction(async tx => {
          const sequence = await lockSubmissionScope(tx, principal, command);
          requireFresh?.();
          const now = clock();
          if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw unavailable();
          const scope = { accountId: principal.localUserId, operationType: submissionOperation,
            targetScope: command.conversationId, key: command.key };
          // A lost HTTP acknowledgement is not proof of rollback. Resolve its
          // committed IDs before checking whether any new work can be admitted.
          const replay = await resolveReplay(tx, scope, command, now, policy);
          requireFresh?.();
          if (replay) return replay;
          const admission = verifiedPolicy(policy);
          await requireNewAdmission(tx, scope.accountId, command.conversationId, admission);
          requireFresh?.();
          const accepted = await persistAcceptance(tx, scope, command, sequence, now, admission, principal);
          requireFresh?.();
          return accepted;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
      } catch (error) {
        // Conflicts expose admission or receipt state, so expiry takes precedence.
        if (error instanceof SubmissionError) requireFresh?.();
        if (error instanceof Prisma.PrismaClientKnownRequestError ||
          error instanceof Prisma.PrismaClientInitializationError) throw unavailable();
        throw error;
      }
    }
  };
}
