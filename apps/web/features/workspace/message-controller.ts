// Conversation use case for one mounted route. It uses the injected API and
// opaque recovery store to submit once and reconcile ambiguous responses by GET.
import type { Acceptance, MessageApi, Scope } from './contracts';
import type { RecoveryRecord, RecoveryStorage } from './submission-recovery-storage';

type MessageState = 'editing' | 'sending' | 'accepted' | 'unknown' | 'checking' | 'history-only' | 'rejected' | 'quota';

function validAcceptance(value: Acceptance) {
  const id = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
  const statusUrl = '/api/v1/generations/' + value.generationId;
  return id.test(value.messageId) && id.test(value.generationId) &&
    value.statusUrl === statusUrl && value.eventsUrl === statusUrl + '/events';
}

export function createMessageController(api: MessageApi, storage: RecoveryStorage, scope: Scope,
  ideaId: string, conversationId: string, isCurrent: (scope: Scope) => boolean, invalidateSession: () => void,
  now = Date.now, makeId = () => crypto.randomUUID()) {
  const target = { localAccountId: scope.account, ideaId, conversationId };
  let record: RecoveryRecord | undefined;
  let state: MessageState = 'editing';
  let initialized = false;
  let acceptance: Acceptance | undefined;
  let requestId: string | undefined;

  function restore() {
    if (initialized || !isCurrent(scope)) return state;
    initialized = true;
    const saved = storage.read(target);
    record = saved.record;
    if (record) state = 'unknown';
    else if (saved.unavailable) state = 'history-only';
    return state;
  }

  function resolveRecord() {
    if (record) storage.remove(record);
    record = undefined;
  }

  function blocked(status: number) {
    if (status !== 401 && status !== 403) return false;
    invalidateSession();
    return true;
  }

  async function send(content: string): Promise<MessageState | undefined> {
    restore();
    if (!isCurrent(scope) || record || !['editing', 'accepted', 'rejected', 'quota'].includes(state)) return;
    if (!content.length || Array.from(content).length > 10_000 || !content.isWellFormed() || content.includes('\0')) {
      return state = 'rejected';
    }
    state = 'sending';
    requestId = undefined;
    acceptance = undefined;
    const body = Object.freeze({ content, clientSubmissionId: makeId() });
    record = storage.save(target, body.clientSubmissionId, makeId());
    try {
      const reply = await api.submit(conversationId, body, record.key, scope.signal);
      // A transport may deliver even after abort. The route and session
      // generations must still match before changing state or storage.
      if (!isCurrent(scope) || blocked(reply.status)) return;
      if ('requestId' in reply) requestId = reply.requestId;
      if (reply.status === 202 && reply.data.status === 'PENDING' && validAcceptance(reply.data)) {
        acceptance = reply.data;
        storage.saveAccepted(target, acceptance.generationId);
        resolveRecord();
        return state = 'accepted';
      }
      if ([400, 404, 409, 413, 415].includes(reply.status)) {
        resolveRecord();
        return state = 'rejected';
      }
      if (reply.status === 429) {
        resolveRecord();
        return state = 'quota';
      }
    } catch {
      if (!isCurrent(scope)) return;
    }
    // A lost acknowledgement can follow a successful commit. Retain only
    // the identifiers and offer a read-only check.
    return state = 'unknown';
  }

  async function check(): Promise<MessageState | undefined> {
    restore();
    if (!isCurrent(scope) || state !== 'unknown') return;
    if (!record || now() >= record.expiresAt) {
      resolveRecord();
      return state = 'history-only';
    }
    state = 'checking';
    requestId = undefined;
    try {
      const reply = await api.correlate(conversationId, record.clientSubmissionId, scope.signal);
      if (!isCurrent(scope) || blocked(reply.status)) return;
      if ('requestId' in reply) requestId = reply.requestId;
      if (reply.status === 200 && reply.data.clientSubmissionId === record.clientSubmissionId && validAcceptance(reply.data)) {
        acceptance = reply.data;
        storage.saveAccepted(target, acceptance.generationId);
        resolveRecord();
        return state = 'accepted';
      }
    } catch {
      if (!isCurrent(scope)) return;
    }
    // A neutral 404 can race a commit. It keeps acceptance unknown.
    return state = 'unknown';
  }

  return { restore, send, check, state: () => state,
    failureRequestId: () => isCurrent(scope) ? requestId : undefined,
    pendingAttempt: () => isCurrent(scope) ? storage.readAccepted(target) : undefined,
    clearPendingAttempt: () => storage.clearAccepted(target),
    acceptance: () => isCurrent(scope) ? acceptance : undefined };
}
