import type { Principal } from './principal.js';
import { SecurityError } from './errors.js';
import { requireClearance } from './suppression-authority.js';
import type { SuppressionAuthority } from './suppression-authority.js';
import type { PrismaClient } from '../generated/prisma/client.js';

export interface IdeaScope { readonly id: string; readonly ownerId: string; readonly status: string }
export interface ChildScope { readonly id: string; readonly ideaId: string }

// Inputs are freshly loaded, server-owned metadata, never request-body owner IDs.
// These policies do not replace transactional lifecycle/version rechecks in use cases.
export async function authorizeIdea(principal: Principal, idea: IdeaScope | null, authority: SuppressionAuthority): Promise<void> {
  if (principal.accountStatus !== 'ACTIVE') throw new SecurityError('ACCOUNT_UNAVAILABLE');
  if (!idea || idea.ownerId !== principal.localUserId || idea.status !== 'ACTIVE') throw new SecurityError('RESOURCE_NOT_FOUND');
  if (principal.subjectKeys.length === 0) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
  for (const key of principal.subjectKeys) await requireClearance(authority, { kind: 'ACCOUNT', instanceId: principal.clerkInstanceId,
    subjectKeyVersion: key.version, subjectKey: key.digest, incarnation: 'ALL' });
  await requireClearance(authority, { kind: 'IDEA', instanceId: principal.clerkInstanceId,
    accountId: principal.localUserId, ideaId: idea.id });
}
export async function authorizeChild(principal: Principal, idea: IdeaScope | null, child: ChildScope | null,
  authority: SuppressionAuthority): Promise<void> {
  if (principal.accountStatus !== 'ACTIVE') throw new SecurityError('ACCOUNT_UNAVAILABLE');
  if (!child || !idea || child.ideaId !== idea.id) throw new SecurityError('RESOURCE_NOT_FOUND');
  await authorizeIdea(principal, idea, authority);
}

// Metadata-only repository boundary. Future use cases must still recheck lifecycle
// and versions inside their own write transactions; no private route uses this yet.
export class PrismaAuthorization {
  constructor(private readonly client: PrismaClient, private readonly authority: SuppressionAuthority) {}
  async idea(principal: Principal, ideaId: string): Promise<IdeaScope> {
    if (principal.accountStatus !== 'ACTIVE') throw new SecurityError('ACCOUNT_UNAVAILABLE');
    if (principal.subjectKeys.length === 0) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
    for (const key of principal.subjectKeys) await requireClearance(this.authority, { kind: 'ACCOUNT',
      instanceId: principal.clerkInstanceId, subjectKeyVersion: key.version,
      subjectKey: key.digest, incarnation: 'ALL' });
    const account = await this.client.userAccount.findFirst({ where: { id: principal.localUserId,
      clerkSubject: principal.clerkSubject, clerkInstanceId: principal.clerkInstanceId },
      select: { status: true, subjectKey: true, subjectKeyVersion: true } });
    if (account?.status !== 'ACTIVE') throw new SecurityError('ACCOUNT_UNAVAILABLE');
    if (!principal.subjectKeys.some(key => key.version === account.subjectKeyVersion && key.digest === account.subjectKey)) {
      throw new SecurityError('DEPENDENCY_UNAVAILABLE');
    }
    const tombstone = await this.client.identityTombstone.findFirst({ where: { clerkInstanceId: principal.clerkInstanceId,
      OR: principal.subjectKeys.map(key => ({ subjectKey: key.digest, subjectKeyVersion: key.version })) }, select: { id: true } });
    const deletion = await this.client.dataOperation.findFirst({ where: { clerkInstanceId: principal.clerkInstanceId,
      kind: 'DELETE_ACCOUNT', OR: principal.subjectKeys.map(key => ({ ownerSubjectKey: key.digest, subjectKeyVersion: key.version })) }, select: { id: true } });
    if (tombstone || deletion) throw new SecurityError('ACCOUNT_UNAVAILABLE');
    const idea = await this.client.idea.findFirst({ where: { id: ideaId, ownerId: principal.localUserId },
      select: { id: true, ownerId: true, status: true } });
    await authorizeIdea(principal, idea, this.authority);
    if (!idea) throw new SecurityError('RESOURCE_NOT_FOUND');
    return idea;
  }
  async conversation(principal: Principal, ideaId: string, conversationId: string): Promise<ChildScope> {
    const idea = await this.idea(principal, ideaId);
    const child = await this.client.conversation.findFirst({ where: { id: conversationId, ideaId: idea.id,
      idea: { ownerId: principal.localUserId } }, select: { id: true, ideaId: true } });
    await authorizeChild(principal, idea, child, this.authority);
    if (!child) throw new SecurityError('RESOURCE_NOT_FOUND');
    return child;
  }
}
