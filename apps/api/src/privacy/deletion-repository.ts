// Isolated deletion persistence. This repository owns the primary transaction;
// the caller verifies the independent intent before invoking it.
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import type { VerifiedIdentity } from '../security/principal.js';
import { SecurityError } from '../security/errors.js';
import { subjectLock, type SubjectKey } from '../security/subject-key.js';

/** A trusted, freshly resolved deletion target and its stable replay identity. */
export interface DeletionTarget {
  readonly identity: VerifiedIdentity;
  readonly accountId: string;
  readonly ideaId: string | null;
  readonly subjectKey: SubjectKey;
  readonly subjectKeys: readonly SubjectKey[];
  readonly scopeKey: string;
  readonly fingerprint: string;
  readonly idempotencyKey: string;
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
  async function lockTarget(tx: Database, target: DeletionTarget) {
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

  return {
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
            deletionOperationId: id, requestedAt: clock.now
          })) });
        }
        const ideas = { ownerId: target.accountId, ...(target.ideaId ? { id: target.ideaId } : {}) };
        await tx.idea.updateMany({ where: ideas, data: { contextEpoch: { increment: 1 },
          ...(target.ideaId ? { status: 'DELETION_REQUESTED', version: { increment: 1 } } : {}) } });
        await tx.generationAttempt.updateMany({ where: { conversation: { idea: ideas },
          status: { in: ['PENDING', 'RUNNING', 'CANCEL_REQUESTED'] } },
        data: { status: 'CANCEL_REQUESTED', leaseEpoch: { increment: 1 }, leaseUntil: null } });
        await tx.researchJob.updateMany({ where: { idea: ideas, status: { in: ['QUEUED', 'RUNNING'] } },
          data: { status: 'CANCELLED', leaseEpoch: { increment: 1 }, leaseUntil: null, completedAt: clock.now } });
        // Existing DataOperation states have no CANCELLED variant. Fence export
        // leases here; the lifecycle gate controls recovery and artifact access.
        await tx.dataOperation.updateMany({ where: { accountId: target.accountId, kind: 'EXPORT',
          ...(target.ideaId ? { OR: [{ ideaId: target.ideaId }, { ideaId: null }] } : {}),
          status: { in: ['REQUESTED', 'RUNNING', 'WAITING_RETRY'] } },
        data: { leaseEpoch: { increment: 1 }, leaseUntil: null } });
        await tx.idempotencyRecord.create({ data: { accountId: target.accountId, operationType: kind,
          targetScope: target.scopeKey, key: target.idempotencyKey, requestFingerprint: target.fingerprint,
          status: 'SUCCEEDED', responseStatus: 202, responseRef: { operationId: id }, expiresAt: receiptExpiry
        }, select: { id: true } });
        await tx.outboxEvent.create({ data: { kind: 'data_operation.requested', aggregateType: 'DataOperation',
          aggregateId: id, payload: { operationId: id } }, select: { id: true } });
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
