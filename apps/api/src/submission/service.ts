// Submission use case. Validate current ownership and suppression evidence
// before asking the repository for an atomic acceptance or durable replay.
import { authorizeChild, type IdeaScope } from '../security/authorization.js';
import { SecurityError } from '../security/errors.js';
import type { Principal } from '../security/principal.js';
import type { RuntimeRecoveryDecision } from '../privacy/runtime-recovery-clearance.js';
import { requireClearance, suppressionWindow, type SuppressionAuthority } from '../security/suppression-authority.js';
import { digest, messageDto, requestFingerprint, storedMessageText, storedStructuredMessage, SubmissionError, transcriptCursor,
  type AcceptanceRef, type MessageCreate, type TranscriptQuery, type TurnAnchor } from './contracts.js';

export interface AdmissionPolicy {
  readonly unit: string;
  readonly operationType: string;
  readonly reservationUnits: number;
  readonly quotaUnits: number;
  readonly deadlineMs: number;
  readonly receiptTtlMs: number;
  readonly requestsPerMinute?: number;
  readonly maximumAdmissions?: number;
  /** Conservative byte bound for the serialized current turn. */
  readonly currentTurnBytes?: number;
}
export type SubmissionScope = { id: string; ideaId: string; status: string; idea: IdeaScope };
export type SubmissionCommand = {
  conversationId: string; ideaId: string; key: string; body: MessageCreate;
  fingerprint: string; contentHash: string;
  executionDecision?: RuntimeRecoveryDecision;
};
export interface SubmissionRepository {
  scope(principal: Principal, conversationId: string): Promise<SubmissionScope | null>;
  accept(principal: Principal, command: SubmissionCommand, clock: () => Date, policy?: AdmissionPolicy,
    requireFresh?: () => void): Promise<AcceptanceRef>;
  correlate(principal: Principal, scope: SubmissionScope, submissionId: string): Promise<AcceptanceRef | null>;
  history(principal: Principal, scope: SubmissionScope, limit: number, after?: TurnAnchor,
    localReadGuard?: () => void): Promise<TranscriptRow[]>;
}

export type TranscriptRow = {
  id: string; conversationId: string; sequence: number; role: string; content: unknown;
  contentSchemaVersion: number; createdAt: Date; turn: number; slot: 0 | 1;
};

export function createSubmissionService(repository: SubmissionRepository, authority: SuppressionAuthority,
  { clock, policy, cursorSecret, executionAdmission, allowSubmission }: { clock: () => Date; policy?: AdmissionPolicy; cursorSecret?: Buffer;
    executionAdmission?: () => Promise<RuntimeRecoveryDecision>;
    allowSubmission?: (principal: Principal, conversationId: string, content: string) => boolean }) {
  const admission = policy && Object.freeze({ ...policy });
  const cursors = cursorSecret && transcriptCursor(cursorSecret);

  async function readScope(principal: Principal, conversationId: string, activeOnly: boolean, source: SuppressionAuthority) {
    if (principal.accountStatus !== 'ACTIVE') throw new SecurityError('ACCOUNT_UNAVAILABLE');
    if (!principal.subjectKeys.length) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
    for (const key of principal.subjectKeys) {
      await requireClearance(source, { kind: 'ACCOUNT', instanceId: principal.clerkInstanceId,
        subjectKeyVersion: key.version, subjectKey: key.digest, incarnation: 'ALL' });
    }
    let scope: SubmissionScope | null;
    try { scope = await repository.scope(principal, conversationId); }
    catch { throw new SecurityError('DEPENDENCY_UNAVAILABLE'); }
    if (!scope || scope.id !== conversationId || !['ACTIVE', 'ARCHIVED'].includes(scope.status)) {
      throw new SecurityError('RESOURCE_NOT_FOUND');
    }
    await authorizeChild(principal, scope.idea, scope, source, activeOnly ? 'write' : 'read');
    return scope;
  }

  return {
    async correlate(principal: Principal, conversationId: string, submissionId: string) {
      const window = suppressionWindow(authority);
      const scope = await readScope(principal, conversationId, true, window.authority);
      const ref = await repository.correlate(principal, scope, submissionId);
      window.requireFresh();
      if (!ref) throw new SubmissionError('NOT_FOUND');
      return ref;
    },
    async history(principal: Principal, conversationId: string, query: TranscriptQuery, localReadGuard?: () => void) {
      const window = suppressionWindow(authority);
      const scope = await readScope(principal, conversationId, Boolean(localReadGuard), window.authority);
      if (localReadGuard && scope.status !== 'ACTIVE') throw new SecurityError('RESOURCE_NOT_FOUND');
      const structured = query.assistantResponseVersion === '2';
      if (!cursors) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
      const limit = query.limit ?? 25;
      const scopeParts = [principal.localUserId, scope.ideaId, conversationId, limit];
      const cursorScope = JSON.stringify(structured ? [...scopeParts, '2'] : scopeParts);
      const after = query.cursor === undefined ? undefined : cursors.decode(cursorScope, query.cursor);
      const rows = await repository.history(principal, scope, limit + 1, after, localReadGuard);
      window.requireFresh();
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
        if (!structured || row.contentSchemaVersion === 1) return dto.data;
        const enriched = storedStructuredMessage.safeParse(row.content);
        if (!enriched.success) throw new SubmissionError('PROJECTION_UNAVAILABLE');
        return { ...dto.data, assistantContent: enriched.data.assistantContent };
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
      if (allowSubmission && !allowSubmission(principal, conversationId, body.content)) {
        throw new SecurityError('RESOURCE_NOT_FOUND', 'SYNTHETIC_SCOPE_MISMATCH');
      }
      if (admission?.currentTurnBytes !== undefined &&
        Buffer.byteLength(JSON.stringify(body.content)) > admission.currentTurnBytes) {
        throw new SubmissionError('PAYLOAD_TOO_LARGE');
      }
      const decision = await executionAdmission?.();
      if (executionAdmission && (!decision || decision.purpose !== 'founders-lens:local-generation:submit' ||
        decision.subjectVersions.join(',') !== principal.subjectKeys.map(ref => ref.version).sort((a, b) => a - b).join(','))) {
        throw new SecurityError('DEPENDENCY_UNAVAILABLE', 'SUBMISSION_CAPABILITY_DENIED');
      }
      const window = suppressionWindow(decision ? { async lookup(scope, query) {
        const evidence = await authority.lookup(scope, query);
        return evidence?.epoch === decision.epoch ? evidence : null;
      } } : authority);
      for (const key of principal.subjectKeys) {
        await requireClearance(window.authority, { kind: 'ACCOUNT', instanceId: principal.clerkInstanceId,
          subjectKeyVersion: key.version, subjectKey: key.digest, incarnation: 'ALL' });
      }
      const scope = await repository.scope(principal, conversationId);
      if (!scope || scope.id !== conversationId) {
        throw new SecurityError('RESOURCE_NOT_FOUND', 'CONVERSATION_NOT_FOUND_OR_NOT_OWNED');
      }
      if (scope.status !== 'ACTIVE') throw new SecurityError('RESOURCE_NOT_FOUND', 'CONVERSATION_INACTIVE');
      // Clearance is independent evidence that access is allowed for this
      // scope. Fetch it outside the transaction, then recheck local state under lock.
      await authorizeChild(principal, scope.idea, scope, window.authority, 'write');
      if (executionAdmission && JSON.stringify(await executionAdmission()) !== JSON.stringify(decision)) {
        throw new SecurityError('DEPENDENCY_UNAVAILABLE', 'SUBMISSION_CAPABILITY_DENIED');
      }
      function requireFresh() {
        window.requireFresh();
        if (decision && Date.now() >= decision.expiresAt) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
      }
      const accepted = await repository.accept(principal, { conversationId, ideaId: scope.ideaId, key, body,
        fingerprint: requestFingerprint(body), contentHash: digest(body.content),
        ...(decision && { executionDecision: decision }) }, clock, admission, requireFresh);
      // An expiry after commit is uncertain. The original receipt is still replayable.
      requireFresh();
      return accepted;
    }
  };
}
export type SubmissionService = ReturnType<typeof createSubmissionService>;
