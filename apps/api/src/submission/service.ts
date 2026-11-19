// Submission use case. Validate current ownership and suppression evidence
// before asking the repository for an atomic acceptance or durable replay.
import { authorizeChild, type IdeaScope } from '../security/authorization.js';
import { SecurityError } from '../security/errors.js';
import type { Principal } from '../security/principal.js';
import { requireClearance, type SuppressionAuthority } from '../security/suppression-authority.js';
import { digest, requestFingerprint, type AcceptanceRef, type MessageCreate } from './contracts.js';

export interface AdmissionPolicy {
  readonly unit: string;
  readonly operationType: string;
  readonly reservationUnits: number;
  readonly quotaUnits: number;
  readonly deadlineMs: number;
  readonly receiptTtlMs: number;
}
export type SubmissionScope = { id: string; ideaId: string; status: string; idea: IdeaScope };
export type SubmissionCommand = {
  conversationId: string; ideaId: string; key: string; body: MessageCreate;
  fingerprint: string; contentHash: string;
};
export interface SubmissionRepository {
  scope(principal: Principal, conversationId: string): Promise<SubmissionScope | null>;
  accept(principal: Principal, command: SubmissionCommand, clock: () => Date, policy?: AdmissionPolicy): Promise<AcceptanceRef>;
}

export function createSubmissionService(repository: SubmissionRepository, authority: SuppressionAuthority,
  { clock, policy }: { clock: () => Date; policy?: AdmissionPolicy }) {
  const admission = policy && Object.freeze({ ...policy });
  return {
    async submit(principal: Principal, conversationId: string, key: string, body: MessageCreate) {
      if (principal.accountStatus !== 'ACTIVE') throw new SecurityError('ACCOUNT_UNAVAILABLE');
      if (!principal.subjectKeys.length) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
      for (const key of principal.subjectKeys) {
        await requireClearance(authority, { kind: 'ACCOUNT', instanceId: principal.clerkInstanceId,
          subjectKeyVersion: key.version, subjectKey: key.digest, incarnation: 'ALL' });
      }
      const scope = await repository.scope(principal, conversationId);
      if (!scope || scope.id !== conversationId || scope.status !== 'ACTIVE') throw new SecurityError('RESOURCE_NOT_FOUND');
      // Clearance is independent evidence that access is allowed for this
      // scope. Fetch it outside the transaction, then recheck local state under lock.
      await authorizeChild(principal, scope.idea, scope, authority, 'write');
      return repository.accept(principal, { conversationId, ideaId: scope.ideaId, key, body,
        fingerprint: requestFingerprint(body), contentHash: digest(body.content) }, clock, admission);
    }
  };
}
export type SubmissionService = ReturnType<typeof createSubmissionService>;
