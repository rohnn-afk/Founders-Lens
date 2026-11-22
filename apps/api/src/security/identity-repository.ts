// Identity persistence layer. The identity service calls this repository to resolve
// or provision a local account after provider and suppression checks.

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../generated/prisma/client.js';
import { SecurityError } from './errors.js';
import type { VerifiedIdentity } from './principal.js';
import type { SubjectKey } from './subject-key.js';
import { subjectLock } from './subject-key.js';

export interface LocalIdentity { readonly id: string; readonly status: 'ACTIVE' }
export interface IdentityRepository {
  resolve(identity: VerifiedIdentity, keys: readonly SubjectKey[], currentVersion: number): Promise<LocalIdentity>;
}
export class PrismaIdentityRepository implements IdentityRepository {
  constructor(private readonly client: PrismaClient) {}
  async resolve(identity: VerifiedIdentity, keys: readonly SubjectKey[], currentVersion: number): Promise<LocalIdentity> {
    return this.resolveAccount(identity, keys, currentVersion, true);
  }

  /** Resolve an existing active binding without provisioning or digest rotation. */
  async resolveExisting(identity: VerifiedIdentity, keys: readonly SubjectKey[], currentVersion: number): Promise<LocalIdentity> {
    return this.resolveAccount(identity, keys, currentVersion, false);
  }

  /** Serialize lookup with deletion and apply writes only for existing provisioning callers. */
  private async resolveAccount(identity: VerifiedIdentity, keys: readonly SubjectKey[], currentVersion: number,
    allowProvisioning: boolean): Promise<LocalIdentity> {
    const current = keys.find(key => key.version === currentVersion);
    if (!current || keys.length === 0) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
    try {
      return await this.client.$transaction(async tx => {
        // A transaction groups database operations into one commit or rollback. This
        // advisory lock uses an agreed subject key, so requests serialize even before
        // an account row exists. Repeated requests converge on one account (idempotency).
        const lock = subjectLock(identity.instanceId, identity.subject);
        await tx.$queryRaw`SELECT 1::integer AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))) AS subject_lock`;
        // A tombstone is a retained marker that prevents account recreation after
        // deletion. Check all retained key versions before looking up or creating the account.
        const tombstone = await tx.identityTombstone.findFirst({ where: { clerkInstanceId: identity.instanceId,
          OR: keys.map(key => ({ subjectKey: key.digest, subjectKeyVersion: key.version })) }, select: { id: true } });
        const deletion = await tx.dataOperation.findFirst({ where: { clerkInstanceId: identity.instanceId,
          kind: 'DELETE_ACCOUNT', OR: keys.map(key => ({ ownerSubjectKey: key.digest, subjectKeyVersion: key.version })) }, select: { id: true } });
        if (tombstone || deletion) throw new SecurityError('ACCOUNT_UNAVAILABLE');
        const account = await tx.userAccount.findUnique({ where: { clerkSubject: identity.subject },
          select: { id: true, status: true, clerkInstanceId: true, subjectKey: true, subjectKeyVersion: true } });
        if (account) {
          if (account.clerkInstanceId !== identity.instanceId || account.status !== 'ACTIVE') throw new SecurityError('ACCOUNT_UNAVAILABLE');
          if (!keys.some(key => key.version === account.subjectKeyVersion && key.digest === account.subjectKey)) {
            throw new SecurityError('DEPENDENCY_UNAVAILABLE');
          }
          if (allowProvisioning && account.subjectKeyVersion !== currentVersion) await tx.userAccount.update({ where: { id: account.id },
            data: { subjectKey: current.digest, subjectKeyVersion: currentVersion } });
          return { id: account.id, status: 'ACTIVE' };
        }
        if (!allowProvisioning) throw new SecurityError('ACCOUNT_UNAVAILABLE');
        // Let PostgreSQL apply account defaults so restricted provisioning needs only these columns.
        const [created] = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO "UserAccount" (id, "clerkSubject", "clerkInstanceId", "subjectKey", "subjectKeyVersion", "updatedAt")
          VALUES (${randomUUID()}::uuid, ${identity.subject}, ${identity.instanceId}, ${current.digest}, ${currentVersion}, ${new Date()})
          RETURNING id`;
        if (!created) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
        return { id: created.id, status: 'ACTIVE' };
      });
    } catch (error) {
      if (error instanceof SecurityError) throw error;
      throw new SecurityError('DEPENDENCY_UNAVAILABLE');
    }
  }
}
