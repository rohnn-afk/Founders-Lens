// Encapsulates owner-scoped persistence and lifecycle transaction locks.
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import type { Principal } from '../security/principal.js';
import { SecurityError } from '../security/errors.js';
import type { IdeaAccess } from '../security/authorization.js';

export const ideaFields = { id: true, title: true, summary: true, status: true, version: true,
  createdAt: true, updatedAt: true } as const;
export const conversationFields = { id: true, ideaId: true, title: true, status: true, proactiveResearch: true,
  metadataVersion: true, createdAt: true, updatedAt: true } as const;
export const accountFields = { id: true, status: true, preferences: true, preferencesVersion: true, createdAt: true } as const;
export type IdeaRow = Prisma.IdeaGetPayload<{ select: typeof ideaFields }>;
export type ConversationRow = Prisma.ConversationGetPayload<{ select: typeof conversationFields }>;
type LedgerScope = Prisma.IdempotencyRecordAccountIdOperationTypeTargetScopeKeyCompoundUniqueInput;
type ReceiptUpdate = Pick<Prisma.IdempotencyRecordUncheckedCreateInput,
  'requestFingerprint' | 'responseRef' | 'status' | 'responseStatus' | 'expiresAt'>;

export class WorkspaceTransaction {
  constructor(private readonly tx: Prisma.TransactionClient) {}
  idea(principal: Principal, id: string, access: IdeaAccess) { return lockIdea(this.tx, principal, id, access); }
  createIdea(data: Prisma.IdeaUncheckedCreateInput) { return this.tx.idea.create({ data, select: ideaFields }); }
  updateIdea(id: string, version: number, data: Prisma.IdeaUpdateInput) {
    return this.tx.idea.update({ where: { id, version }, data, select: ideaFields });
  }
  ledger(scope: LedgerScope) {
    return this.tx.idempotencyRecord.findUnique({ where: { accountId_operationType_targetScope_key: scope } });
  }
  async saveReceipt(scope: LedgerScope, previousId: string | undefined, data: ReceiptUpdate) {
    if (previousId) await this.tx.idempotencyRecord.update({ where: { id: previousId }, data });
    else await this.tx.idempotencyRecord.create({ data: { ...scope, ...data } });
  }
  conversations(ideaId: string, anchor: Anchor | undefined, take: number) {
    return this.tx.conversation.findMany({ where: { ideaId, ...after(anchor) }, orderBy: [...pageOrder], take, select: conversationFields });
  }
  createConversation(data: Prisma.ConversationUncheckedCreateInput) {
    return this.tx.conversation.create({ data, select: conversationFields });
  }
  conversation(id: string, ideaId: string) {
    return this.tx.conversation.findFirst({ where: { id, ideaId }, select: conversationFields });
  }
  account(id: string) { return this.tx.userAccount.findUniqueOrThrow({ where: { id }, select: accountFields }); }
  updatePreferences(id: string, preferencesVersion: number, preferences: Prisma.InputJsonObject) {
    return this.tx.userAccount.update({ where: { id, preferencesVersion },
      data: { preferences, preferencesVersion: { increment: 1 } }, select: accountFields });
  }
}
export type Anchor = { id: string; updatedAt: Date };
export const pageOrder = [{ updatedAt: 'desc' }, { id: 'desc' }] as const;
// Resume after the last timestamp and ID in sort order. The ID breaks ties
// when multiple rows have the same timestamp.
export function after(anchor?: Anchor) {
  return anchor ? { OR: [{ updatedAt: { lt: anchor.updatedAt } },
    { updatedAt: anchor.updatedAt, id: { lt: anchor.id } }] } : {};
}
export function ideaScope(principal: Principal, access: IdeaAccess): Prisma.IdeaWhereInput {
  // Archived ideas remain visible to their owner on reads. The same predicate
  // excludes them from writes when state is checked again under lock.
  return { ownerId: principal.localUserId, status: { in: access === 'read'
    ? ['ACTIVE', 'ARCHIVED'] : ['ACTIVE'] } };
}
export class WorkspaceRepository {
  constructor(private readonly client: PrismaClient) {}

  ideaMetadata(principal: Principal, id: string) {
    return this.client.idea.findFirst({ where: { id, ownerId: principal.localUserId },
      select: { id: true, ownerId: true, status: true } });
  }

  ideaPageMetadata(principal: Principal, anchor: Anchor | undefined, take: number) {
    return this.client.idea.findMany({ where: { ...ideaScope(principal, 'read'), ...after(anchor) },
      orderBy: [...pageOrder], take, select: { id: true, ownerId: true, status: true, updatedAt: true } });
  }

  conversationParent(principal: Principal, id: string) {
    return this.client.conversation.findFirst({ where: { id, idea: ideaScope(principal, 'read') }, select: { ideaId: true } });
  }

  async transaction<T>(principal: Principal, action: (tx: WorkspaceTransaction) => Promise<T>): Promise<T> {
    try {
      return await this.client.$transaction(async tx => {
        // Recheck the account in the same transaction as the read or write.
        // Lock it before any idea to match the lifecycle lock order and avoid
        // two transactions waiting on locks held by each other in reverse order.
        const accounts = await tx.$queryRaw<{ status: string; subjectKey: string; subjectKeyVersion: number }[]>
          `SELECT status, "subjectKey", "subjectKeyVersion" FROM "UserAccount"
            WHERE id = ${principal.localUserId}::uuid AND "clerkSubject" = ${principal.clerkSubject}
            AND "clerkInstanceId" = ${principal.clerkInstanceId} FOR UPDATE`;
        const account = accounts[0];
        if (!account || account.status !== 'ACTIVE') throw new SecurityError('ACCOUNT_UNAVAILABLE');
        if (!principal.subjectKeys.some(key => key.version === account.subjectKeyVersion && key.digest === account.subjectKey)) {
          throw new SecurityError('DEPENDENCY_UNAVAILABLE');
        }
        const tombstone = await tx.identityTombstone.findFirst({ where: { clerkInstanceId: principal.clerkInstanceId,
          OR: principal.subjectKeys.map(key => ({ subjectKey: key.digest, subjectKeyVersion: key.version })) }, select: { id: true } });
        const deletion = await tx.dataOperation.findFirst({ where: { clerkInstanceId: principal.clerkInstanceId,
          kind: 'DELETE_ACCOUNT', OR: principal.subjectKeys.map(key => ({ ownerSubjectKey: key.digest, subjectKeyVersion: key.version })) },
          select: { id: true } });
        if (tombstone || deletion) throw new SecurityError('ACCOUNT_UNAVAILABLE');
        return action(new WorkspaceTransaction(tx));
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError ||
        error instanceof Prisma.PrismaClientInitializationError) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
      throw error;
    }
  }
}

export async function lockIdea(tx: Prisma.TransactionClient, principal: Principal, id: string, access: IdeaAccess) {
  await tx.$queryRaw`SELECT id FROM "Idea" WHERE id = ${id}::uuid AND "ownerId" = ${principal.localUserId}::uuid FOR UPDATE`;
  const idea = await tx.idea.findFirst({ where: { id, ...ideaScope(principal, access) }, select: ideaFields });
  if (!idea) throw new SecurityError('RESOURCE_NOT_FOUND');
  return idea;
}
