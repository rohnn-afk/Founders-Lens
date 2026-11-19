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
    const current = keys.find(key => key.version === currentVersion);
    if (!current || keys.length === 0) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
    try {
      return await this.client.$transaction(async tx => {
        const lock = subjectLock(identity.instanceId, identity.subject);
        await tx.$queryRaw`SELECT 1::integer AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))) AS subject_lock`;
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
          if (account.subjectKeyVersion !== currentVersion) await tx.userAccount.update({ where: { id: account.id },
            data: { subjectKey: current.digest, subjectKeyVersion: currentVersion } });
          return { id: account.id, status: 'ACTIVE' };
        }
        const created = await tx.userAccount.create({ data: { id: randomUUID(), clerkSubject: identity.subject,
          clerkInstanceId: identity.instanceId, subjectKey: current.digest, subjectKeyVersion: currentVersion }, select: { id: true } });
        return { id: created.id, status: 'ACTIVE' };
      });
    } catch (error) {
      if (error instanceof SecurityError) throw error;
      throw new SecurityError('DEPENDENCY_UNAVAILABLE');
    }
  }
}
