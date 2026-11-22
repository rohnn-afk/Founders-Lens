// Isolated deletion persistence. This repository owns the primary transaction;
// the caller verifies the independent intent before invoking it.
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import type { VerifiedIdentity } from '../security/principal.js';
import { SecurityError } from '../security/errors.js';
import type { SuppressionScope } from '../security/suppression-authority.js';
import { subjectLock, type SubjectKey, type SubjectKeys } from '../security/subject-key.js';

/** A trusted, freshly resolved deletion target and its stable replay identity. */
export interface DeletionTarget extends RecoveryTarget {
  readonly idempotencyKey: string;
}

/** Primary scope verified against an independent intent. */
export interface RecoveryTarget {
  readonly identity: Pick<VerifiedIdentity, 'instanceId' | 'subject'>;
  readonly accountId: string;
  readonly ideaId: string | null;
  readonly subjectKey: SubjectKey;
  readonly subjectKeys: readonly SubjectKey[];
  readonly scopeKey: string;
  readonly fingerprint: string;
  readonly policyVersion: string;
}

type Database = Prisma.TransactionClient;
type Reservation = { operationId: string; challengeKey: string };

/** Construct the restricted persistence boundary for the unmounted use case. */
export function createDeletionRepository(client: PrismaClient) {
  /** Resolve only owner and lifecycle metadata, including pending targets for replay. */
  async function resolve(identity: VerifiedIdentity, ideaId: string | null, subjectKeys: readonly SubjectKey[]) {
    const account = await client.userAccount.findFirst({ where: {
      clerkInstanceId: identity.instanceId, clerkSubject: identity.subject
    }, select: { id: true, subjectKey: true, subjectKeyVersion: true, status: true } });
    const key = subjectKeys.find(k => k.version === account?.subjectKeyVersion && k.digest === account.subjectKey);
    if (!account || !key) throw new SecurityError('RESOURCE_NOT_FOUND');
    const idea = ideaId && await client.idea.findFirst({ where: { id: ideaId, ownerId: account.id }, select: { status: true } });
    if (ideaId && !idea) throw new SecurityError('RESOURCE_NOT_FOUND');
    return { accountId: account.id, subjectKey: key, eligible: idea
      ? account.status === 'ACTIVE' && ['ACTIVE', 'ARCHIVED'].includes(idea.status)
      : ['ACTIVE', 'DISABLED'].includes(account.status) };
  }

  /** Load only an exact committed receipt, and verify its durable operation binding. */
  async function replay(target: DeletionTarget, db: Database = client) {
    const kind = target.ideaId ? 'DELETE_IDEA' : 'DELETE_ACCOUNT';
    const receipt = await db.idempotencyRecord.findUnique({ where: { accountId_operationType_targetScope_key: {
      accountId: target.accountId, operationType: kind, targetScope: target.scopeKey, key: target.idempotencyKey
    } } });
    if (!receipt) return null;
    const ref = receipt.responseRef as { operationId?: string } | null;
    if (receipt.requestFingerprint !== target.fingerprint || receipt.responseStatus !== 202 ||
      receipt.status !== 'SUCCEEDED' || typeof ref?.operationId !== 'string') throw new SecurityError('ACCOUNT_UNAVAILABLE');
    const operation = await db.dataOperation.findFirst({ where: { id: ref.operationId, kind,
      accountId: target.accountId, ideaId: target.ideaId, clerkInstanceId: target.identity.instanceId,
      ownerSubjectKey: target.subjectKey.digest, subjectKeyVersion: target.subjectKey.version,
      deletionScopeKey: target.scopeKey, policyVersion: target.policyVersion
    }, select: { id: true, reverificationKey: true } });
    if (!operation?.reverificationKey) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
    return { operationId: operation.id, challengeKey: operation.reverificationKey };
  }

  /** Serialize by subject, then account and idea, before applying the local deletion gate. */
  async function lockTarget(tx: Database, target: RecoveryTarget) {
    const identity = target.identity;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${subjectLock(identity.instanceId, identity.subject)}, 0))`;
    const [account] = await tx.$queryRaw<{ status: string }[]>
      `SELECT status FROM "UserAccount" WHERE id=${target.accountId}::uuid AND "clerkInstanceId"=${identity.instanceId}
        AND "clerkSubject"=${identity.subject} AND "subjectKeyVersion"=${target.subjectKey.version}
        AND "subjectKey"=${target.subjectKey.digest} FOR UPDATE`;
    if (!account) throw new SecurityError('RESOURCE_NOT_FOUND');
    if (target.ideaId) {
      const [idea] = await tx.$queryRaw<{ status: string }[]>
        `SELECT status FROM "Idea" WHERE id=${target.ideaId}::uuid AND "ownerId"=${target.accountId}::uuid FOR UPDATE`;
      if (!idea) throw new SecurityError('RESOURCE_NOT_FOUND');
      return { account: account.status, idea: idea.status };
    }
    return { account: account.status, idea: null };
  }

  /** Install local suppression and fence work atomically with the operation. */
  async function applyDeletion(tx: Database, target: RecoveryTarget, reservation: Reservation, now: Date, operationDeadline: Date) {
    const id = reservation.operationId;
    const kind = target.ideaId ? 'DELETE_IDEA' : 'DELETE_ACCOUNT';
    // The existing unique reverificationKey constraint is the primary guard.
    // The independent ledger already reserved the challenge before these locks.
    await tx.dataOperation.create({ data: { id, kind, accountId: target.accountId, ideaId: target.ideaId,
      clerkInstanceId: target.identity.instanceId, ownerSubjectKey: target.subjectKey.digest,
      subjectKeyVersion: target.subjectKey.version, deletionScopeKey: target.scopeKey,
      reverificationKey: reservation.challengeKey, policyVersion: target.policyVersion,
      deletionState: 'DELETION_REQUESTED', deadlineAt: operationDeadline
    }, select: { id: true } });
    if (!target.ideaId) {
      await tx.userAccount.update({ where: { id: target.accountId }, data: { status: 'DELETION_REQUESTED' }, select: { id: true } });
      await tx.identityTombstone.createMany({ data: target.subjectKeys.map(key => ({
        clerkInstanceId: target.identity.instanceId, subjectKey: key.digest, subjectKeyVersion: key.version,
        deletionOperationId: id, requestedAt: now
      })) });
    }
    const ideas = { ownerId: target.accountId, ...(target.ideaId ? { id: target.ideaId } : {}) };
    await tx.idea.updateMany({ where: ideas, data: { contextEpoch: { increment: 1 },
      ...(target.ideaId ? { status: 'DELETION_REQUESTED', version: { increment: 1 } } : {}) } });
    await tx.generationAttempt.updateMany({ where: { conversation: { idea: ideas },
      status: { in: ['PENDING', 'RUNNING', 'CANCEL_REQUESTED'] } },
    data: { status: 'CANCEL_REQUESTED', leaseEpoch: { increment: 1 }, leaseUntil: null } });
    await tx.researchJob.updateMany({ where: { idea: ideas, status: { in: ['QUEUED', 'RUNNING'] } },
      data: { status: 'CANCELLED', leaseEpoch: { increment: 1 }, leaseUntil: null, completedAt: now } });
    // Existing DataOperation states have no CANCELLED variant. Fence export
    // leases here; the lifecycle gate controls recovery and artifact access.
    await tx.dataOperation.updateMany({ where: { accountId: target.accountId, kind: 'EXPORT',
      ...(target.ideaId ? { OR: [{ ideaId: target.ideaId }, { ideaId: null }] } : {}),
      status: { in: ['REQUESTED', 'RUNNING', 'WAITING_RETRY'] } },
    data: { leaseEpoch: { increment: 1 }, leaseUntil: null } });
  }

  /** Queue the exact committed operation inside its primary transaction. */
  async function enqueueDeletion(tx: Database, id: string) {
    await tx.outboxEvent.create({ data: { kind: 'data_operation.requested', aggregateType: 'DataOperation',
      aggregateId: id, payload: { operationId: id } }, select: { id: true } });
  }

  /** Identify the restored database using PostgreSQL control data, not restored rows. */
  async function recoveryIdentity() {
    const [row] = await client.$queryRaw<{ target: string }[]>`
      SELECT system_identifier::text || ':' || d.oid::text AS target
      FROM pg_catalog.pg_control_system(), pg_catalog.pg_database d WHERE d.datname=current_database()
    `;
    if (!row) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
    return row.target;
  }

  /** Find the original incarnation and derive its complete retained subject keys. */
  async function resolveRecovery(scope: SuppressionScope, keys: SubjectKeys, matchesIncarnation: (id: string) => boolean) {
    const candidates = await client.userAccount.findMany({ where: { clerkInstanceId: scope.instanceId,
      ...(scope.kind === 'IDEA' ? { id: scope.accountId } : {}) }, take: 257,
      select: { id: true, clerkSubject: true, subjectKey: true, subjectKeyVersion: true } });
    if (candidates.length > 256) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
    const matches = candidates.filter(account => scope.kind === 'IDEA' || matchesIncarnation(account.id));
    if (matches.length !== 1) throw new SecurityError('RESOURCE_NOT_FOUND');
    const account = matches[0]!;
    const subjectKeys = keys.derive(scope.instanceId, account.clerkSubject);
    const subjectKey = subjectKeys.find(key => key.version === account.subjectKeyVersion && key.digest === account.subjectKey);
    if (!subjectKey || (scope.kind === 'ACCOUNT' && !subjectKeys.some(key =>
      key.version === scope.subjectKeyVersion && key.digest === scope.subjectKey))) throw new SecurityError('RESOURCE_NOT_FOUND');
    return { identity: { instanceId: scope.instanceId, subject: account.clerkSubject }, accountId: account.id,
      subjectKey, subjectKeys, ideaId: scope.kind === 'IDEA' ? scope.ideaId : null };
  }

  /** Reapply a missing gate or verify exact existing effects under the primary locks. */
  async function reconcile(target: RecoveryTarget, reservation: Reservation, deadline: Date) {
    return client.$transaction(async tx => {
      const lifecycle = await lockTarget(tx, target);
      const id = reservation.operationId;
      const pending = target.ideaId ? lifecycle.idea : lifecycle.account;
      const kind = target.ideaId ? 'DELETE_IDEA' : 'DELETE_ACCOUNT';
      const operations = await tx.dataOperation.findMany({ where: { OR: [
        { id }, { deletionScopeKey: target.scopeKey }, { reverificationKey: reservation.challengeKey }
      ] } });
      const receipts = await tx.idempotencyRecord.findMany({ where: { accountId: target.accountId,
        operationType: kind, targetScope: target.scopeKey } });
      const events = await tx.outboxEvent.findMany({ where: { aggregateId: id } });
      const tombstones = target.ideaId ? [] : await tx.identityTombstone.findMany({ where: {
        clerkInstanceId: target.identity.instanceId, OR: target.subjectKeys.map(key =>
          ({ subjectKey: key.digest, subjectKeyVersion: key.version }))
      } });
      if (operations.length > 0) {
        const operation = operations[0]!;
        if (operations.length !== 1 || operation.id !== id || operation.kind !== kind ||
          operation.accountId !== target.accountId || operation.ideaId !== target.ideaId ||
          operation.clerkInstanceId !== target.identity.instanceId ||
          !target.subjectKeys.some(key => key.version === operation.subjectKeyVersion && key.digest === operation.ownerSubjectKey) ||
          operation.deletionScopeKey !== target.scopeKey || operation.policyVersion !== target.policyVersion ||
          operation.reverificationKey !== reservation.challengeKey || operation.deletionState !== 'DELETION_REQUESTED' ||
          pending !== 'DELETION_REQUESTED' || events.length !== 1 || events[0]!.aggregateType !== 'DataOperation' ||
          events[0]!.kind !== 'data_operation.requested' ||
          (events[0]!.payload as { operationId?: string } | null)?.operationId !== id ||
          receipts.length > 1 || receipts.some(receipt => receipt.requestFingerprint !== target.fingerprint ||
            receipt.status !== 'SUCCEEDED' || receipt.responseStatus !== 202 ||
            (receipt.responseRef as { operationId?: string } | null)?.operationId !== id) ||
          (!target.ideaId && (tombstones.length !== target.subjectKeys.length ||
            tombstones.some(row => row.deletionOperationId !== id)))) {
          throw new SecurityError('DEPENDENCY_UNAVAILABLE');
        }
        // A surviving operation is insufficient if restored work can still
        // present a live lease or an uncancelled generation state.
        const ideas = { ownerId: target.accountId, ...(target.ideaId ? { id: target.ideaId } : {}) };
        if (await tx.generationAttempt.count({ where: { conversation: { idea: ideas }, OR: [
          { status: { in: ['PENDING', 'RUNNING'] } }, { status: 'CANCEL_REQUESTED', leaseUntil: { not: null } }
        ] } }) || await tx.researchJob.count({ where: { idea: ideas, status: { in: ['QUEUED', 'RUNNING'] } } }) ||
          await tx.dataOperation.count({ where: { accountId: target.accountId, kind: 'EXPORT',
            ...(target.ideaId ? { OR: [{ ideaId: target.ideaId }, { ideaId: null }] } : {}),
            status: { in: ['REQUESTED', 'RUNNING', 'WAITING_RETRY'] }, leaseUntil: { not: null } } })) {
          throw new SecurityError('DEPENDENCY_UNAVAILABLE');
        }
        return;
      }
      if (receipts.length || events.length || tombstones.length ||
        !['ACTIVE', target.ideaId ? 'ARCHIVED' : 'DISABLED'].includes(pending ?? '') ||
        (target.ideaId && !['ACTIVE', 'DELETION_REQUESTED'].includes(lifecycle.account))) {
        throw new SecurityError('DEPENDENCY_UNAVAILABLE');
      }
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (!clock) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
      await applyDeletion(tx, target, reservation, clock.now, deadline);
      // A reconstructed suppression gate cannot prove a historical user response.
      await enqueueDeletion(tx, id);
    });
  }

  return {
    recoveryIdentity,
    resolveRecovery,
    reconcile,
    /** Only metadata is exposed for the isolated post-recovery access assertion. */
    async readFixtureScope(accountId: string, ideaId: string, keys: SubjectKeys) {
      const account = await client.userAccount.findUnique({ where: { id: accountId },
        select: { clerkInstanceId: true, clerkSubject: true, subjectKey: true, subjectKeyVersion: true, status: true } });
      const idea = await client.idea.findFirst({ where: { id: ideaId, ownerId: accountId }, select: { status: true } });
      if (account?.status !== 'ACTIVE' || idea?.status !== 'ACTIVE') throw new SecurityError('RESOURCE_NOT_FOUND');
      const subjectKeys = keys.derive(account.clerkInstanceId, account.clerkSubject);
      if (!subjectKeys.some(key => key.digest === account.subjectKey && key.version === account.subjectKeyVersion)) {
        throw new SecurityError('DEPENDENCY_UNAVAILABLE');
      }
      return { instanceId: account.clerkInstanceId, subjectKeys };
    },
    resolve,
    replay,
    /** Commit all local effects or reject. No authority or Clerk calls belong in this transaction. */
    async commit(target: DeletionTarget, reservation: Reservation, validUntil: number,
      operationDeadline: Date, receiptExpiry: Date) {
      return client.$transaction(async tx => {
        const lifecycle = await lockTarget(tx, target);
        const existing = await replay(target, tx);
        if (existing) {
          if (existing.operationId !== reservation.operationId || existing.challengeKey !== reservation.challengeKey) {
            throw new SecurityError('ACCOUNT_UNAVAILABLE');
          }
          return existing.operationId;
        }
        const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
        if (!clock || clock.now.getTime() >= validUntil ||
          !['ACTIVE', ...(target.ideaId ? [] : ['DISABLED'])].includes(lifecycle.account) ||
          (target.ideaId && !['ACTIVE', 'ARCHIVED'].includes(lifecycle.idea ?? ''))) {
          throw new SecurityError('ACCOUNT_UNAVAILABLE');
        }
        const kind = target.ideaId ? 'DELETE_IDEA' : 'DELETE_ACCOUNT';
        const id = reservation.operationId;
        await applyDeletion(tx, target, reservation, clock.now, operationDeadline);
        await tx.idempotencyRecord.create({ data: { accountId: target.accountId, operationType: kind,
          targetScope: target.scopeKey, key: target.idempotencyKey, requestFingerprint: target.fingerprint,
          status: 'SUCCEEDED', responseStatus: 202, responseRef: { operationId: id }, expiresAt: receiptExpiry
        }, select: { id: true } });
        await enqueueDeletion(tx, id);
        // Later writes can wait on locks even after we have locked the target.
        // Roll back every primary effect if the proof expired during those waits.
        const [freshness] = await tx.$queryRaw<{ valid: boolean }[]>
          `SELECT clock_timestamp() < to_timestamp(${validUntil}::double precision / 1000) AS valid`;
        if (!freshness?.valid) throw new SecurityError('UNAUTHENTICATED');
        return id;
      });
    }
  };
}
