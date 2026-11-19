// Shared persistence guard. Repositories invoke it first inside a transaction
// to serialize account-scoped work and recheck identity and deletion state.
import type { Prisma } from '../generated/prisma/client.js';
import { SecurityError } from '../security/errors.js';
import type { Principal } from '../security/principal.js';

export async function lockWorkspaceAccount(tx: Prisma.TransactionClient, principal: Principal) {
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
}
