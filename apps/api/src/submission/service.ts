// Submission use case. Validate current ownership and suppression evidence
// before asking the repository for an atomic acceptance or durable replay.
import { authorizeChild, type IdeaScope } from '../security/authorization.js';
import { SecurityError } from '../security/errors.js';
import type { Principal } from '../security/principal.js';
import { requireClearance, type SuppressionAuthority } from '../security/suppression-authority.js';
import { digest, messageDto, requestFingerprint, storedMessageText, SubmissionError, transcriptCursor,
  type AcceptanceRef, type MessageCreate, type TranscriptQuery, type TurnAnchor } from './contracts.js';

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
  correlate(principal: Principal, scope: SubmissionScope, submissionId: string): Promise<AcceptanceRef | null>;
  history(principal: Principal, scope: SubmissionScope, limit: number, after?: TurnAnchor,
    localReadGuard?: () => void): Promise<TranscriptRow[]>;
}

export type TranscriptRow = {
  id: string; conversationId: string; sequence: number; role: string; content: unknown;
  contentSchemaVersion: number; createdAt: Date; turn: number; slot: 0 | 1;
};

export function createSubmissionService(repository: SubmissionRepository, authority: SuppressionAuthority,
  { clock, policy, cursorSecret }: { clock: () => Date; policy?: AdmissionPolicy; cursorSecret?: Buffer }) {
  const admission = policy && Object.freeze({ ...policy });
  const cursors = cursorSecret && transcriptCursor(cursorSecret);

  async function readScope(principal: Principal, conversationId: string, activeOnly: boolean) {
    if (principal.accountStatus !== 'ACTIVE') throw new SecurityError('ACCOUNT_UNAVAILABLE');
    if (!principal.subjectKeys.length) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
    for (const key of principal.subjectKeys) {
      await requireClearance(authority, { kind: 'ACCOUNT', instanceId: principal.clerkInstanceId,
        subjectKeyVersion: key.version, subjectKey: key.digest, incarnation: 'ALL' });
    }
    let scope: SubmissionScope | null;
    try { scope = await repository.scope(principal, conversationId); }
    catch { throw new SecurityError('DEPENDENCY_UNAVAILABLE'); }
    if (!scope || scope.id !== conversationId || !['ACTIVE', 'ARCHIVED'].includes(scope.status)) {
      throw new SecurityError('RESOURCE_NOT_FOUND');
    }
    await authorizeChild(principal, scope.idea, scope, authority, activeOnly ? 'write' : 'read');
    return scope;
  }

  return {
    async correlate(principal: Principal, conversationId: string, submissionId: string) {
      const scope = await readScope(principal, conversationId, true);
      const ref = await repository.correlate(principal, scope, submissionId);
      if (!ref) throw new SubmissionError('NOT_FOUND');
      return ref;
    },
    async history(principal: Principal, conversationId: string, query: TranscriptQuery, localReadGuard?: () => void) {
      const scope = await readScope(principal, conversationId, Boolean(localReadGuard));
      if (localReadGuard && scope.status !== 'ACTIVE') throw new SecurityError('RESOURCE_NOT_FOUND');
      // The isolated slice explicitly reports an unavailable projection for
      // valid v2 requests until the structured transcript is implemented.
      if (query.assistantResponseVersion === '2') throw new SubmissionError('PROJECTION_UNAVAILABLE');
      if (!cursors) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
      const limit = query.limit ?? 25;
      const cursorScope = JSON.stringify([principal.localUserId, scope.ideaId, conversationId, limit]);
      const after = query.cursor === undefined ? undefined : cursors.decode(cursorScope, query.cursor);
      const rows = await repository.history(principal, scope, limit + 1, after, localReadGuard);
      const pageRows = rows.slice(0, limit);
      const items = pageRows.map(row => {
        if (row.contentSchemaVersion !== 1 && !(row.role === 'ASSISTANT' && row.contentSchemaVersion === 2)) {
          throw new SubmissionError('PROJECTION_UNAVAILABLE');
        }
        const text = storedMessageText.safeParse(row.content);
        if (!text.success) throw new SubmissionError('PROJECTION_UNAVAILABLE');
        const dto = messageDto.safeParse({ id: row.id, conversationId: row.conversationId, sequence: row.sequence,
          role: row.role, content: text.data.text, createdAt: row.createdAt.toISOString() });
        if (!dto.success) throw new SubmissionError('PROJECTION_UNAVAILABLE');
        return dto.data;
      });
      if (Buffer.byteLength(JSON.stringify(items)) > 8 * 1024 * 1024) throw new SubmissionError('PROJECTION_UNAVAILABLE');
      const last = pageRows.at(-1);
      const hasMore = rows.length > limit;
      return { items, page: { hasMore, nextCursor: hasMore && last
        ? cursors.encode(cursorScope, [last.turn, last.slot]) : null } };
    },
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
