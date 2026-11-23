// Browser storage boundary for opaque submission IDs. The workspace supplies
// storage and TTL so the controller can recover across reload without storing text.
export type RecoveryScope = { localAccountId: string; ideaId: string; conversationId: string };
export type RecoveryRecord = RecoveryScope & {
  recordVersion: 1; clientSubmissionId: string; key: string; createdAt: number; expiresAt: number;
  messageId?: string; generationId?: string;
};

const prefix = 'founders-lens.submission.v1:';
const fields = new Set(['recordVersion', 'localAccountId', 'ideaId', 'conversationId', 'clientSubmissionId',
  'key', 'createdAt', 'expiresAt', 'messageId', 'generationId']);
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const uuid = (value: unknown): value is string => typeof value === 'string' && uuidPattern.test(value);
const ownerId = (value: unknown) => uuid(value) || (typeof value === 'string' && /^user_[a-zA-Z0-9_-]{1,250}$/.test(value));

export function createRecoveryStorage(getStorage: () => Storage, ttl: number, now = Date.now, sessionId?: string) {
  const unavailableScopes = new Set<string>();
  const submissionPrefix = sessionId ? prefix + encodeURIComponent(sessionId) + ':' : prefix;
  const scopePrefix = (scope: RecoveryScope) =>
    submissionPrefix + [scope.localAccountId, scope.ideaId, scope.conversationId].join(':') + ':';
  const recordKey = (record: RecoveryRecord) => scopePrefix(record) + record.clientSubmissionId;
  const acceptedPrefix = 'founders-lens.accepted.v1:';
  const acceptedKey = (scope: RecoveryScope) => acceptedPrefix +
    JSON.stringify([sessionId, scope.localAccountId, scope.ideaId, scope.conversationId]);
  function valid(value: unknown, time: number): value is RecoveryRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    const { recordVersion, localAccountId, ideaId, conversationId, clientSubmissionId, key,
      createdAt, expiresAt, messageId, generationId } = row;
    // An exact allowlist also rejects records carrying accidentally persisted text.
    return Object.keys(row).every(name => fields.has(name)) && recordVersion === 1 &&
      ownerId(localAccountId) && uuid(ideaId) && uuid(conversationId) && uuid(clientSubmissionId) &&
      typeof key === 'string' && key.length >= 8 && key.length <= 128 &&
      (messageId === undefined || uuid(messageId)) && (generationId === undefined || uuid(generationId)) &&
      typeof createdAt === 'number' && Number.isSafeInteger(createdAt) && createdAt >= 0 && createdAt <= time &&
      typeof expiresAt === 'number' && Number.isSafeInteger(expiresAt) && expiresAt > time && expiresAt - createdAt === ttl;
  }
  function records(account?: string) {
    const result: RecoveryRecord[] = [];
    try {
      const storage = getStorage();
      const time = now();
      for (let index = storage.length - 1; index >= 0; index--) {
        const key = storage.key(index);
        if (!key?.startsWith(submissionPrefix)) continue;
        let row: unknown;
        try {
          const raw = storage.getItem(key);
          if (raw && raw.length <= 2048) row = JSON.parse(raw);
        } catch { /* Invalid records are removed below. */ }
        // The key and payload must describe the same account and resource.
        if (valid(row, time) && key === recordKey(row) && (account === undefined || row.localAccountId === account)) {
          result.push(row);
        } else {
          const [owner, idea, conversation, submission, extra] = key.slice(submissionPrefix.length).split(':');
          if (ownerId(owner) && uuid(idea) && uuid(conversation) && uuid(submission) && extra === undefined &&
            (account === undefined || owner === account)) {
            unavailableScopes.add(scopePrefix({ localAccountId: owner, ideaId: idea, conversationId: conversation }));
          }
          storage.removeItem(key);
        }
      }
      return { result, available: true };
    } catch { return { result: [], available: false }; }
  }
  return {
    /** Store only the polling target and deadline, scoped to the actual Clerk session. */
    saveAccepted(scope: RecoveryScope, generationId: string) {
      if (!sessionId || !uuid(generationId)) return;
      try { getStorage().setItem(acceptedKey(scope), JSON.stringify({ generationId, expiresAt: now() + ttl })); }
      catch { /* Polling can still proceed in the mounted view. */ }
    },
    readAccepted(scope: RecoveryScope): string | undefined {
      if (!sessionId) return;
      try {
        const storage = getStorage(), key = acceptedKey(scope);
        const raw = storage.getItem(key);
        if (raw && raw.length < 256) {
          const value: unknown = JSON.parse(raw);
          if (value && typeof value === 'object' && 'generationId' in value && uuid(value.generationId) &&
            'expiresAt' in value && typeof value.expiresAt === 'number' && Number.isSafeInteger(value.expiresAt) &&
            value.expiresAt > now() && value.expiresAt <= now() + ttl) return value.generationId;
        }
        storage.removeItem(key);
      } catch { /* Storage may be denied or corrupt. */ }
    },
    clearAccepted(scope: RecoveryScope) {
      if (!sessionId) return;
      try { getStorage().removeItem(acceptedKey(scope)); } catch { /* Storage can be denied. */ }
    },
    read(scope: RecoveryScope) {
      const { result, available } = records();
      const key = scopePrefix(scope);
      return { record: result.filter(row => scopePrefix(row) === key)
        .sort((a, b) => b.createdAt - a.createdAt)[0], unavailable: !available || unavailableScopes.has(key) };
    },
    save(scope: RecoveryScope, clientSubmissionId: string, key: string) {
      // The deadline is created once, before dispatch. Reads never renew it.
      const createdAt = now();
      const record = { ...scope, recordVersion: 1 as const, clientSubmissionId, key, createdAt, expiresAt: createdAt + ttl };
      try { if (valid(record, createdAt)) getStorage().setItem(recordKey(record), JSON.stringify(record)); }
      catch { /* The current view can still reconcile its in-memory identifier. */ }
      return record;
    },
    remove(record: RecoveryRecord) {
      unavailableScopes.delete(scopePrefix(record));
      try { getStorage().removeItem(recordKey(record)); } catch { /* Storage can be denied. */ }
    },
    sweep(account: string) { records(account); },
    removeIdea(account: string, ideaId: string) {
      const ideaPrefix = submissionPrefix + account + ':' + ideaId + ':';
      for (const key of unavailableScopes) if (key.startsWith(ideaPrefix)) unavailableScopes.delete(key);
      try {
        const storage = getStorage();
        for (let index = storage.length - 1; index >= 0; index--) {
          const key = storage.key(index);
          if (key?.startsWith(ideaPrefix) || key?.startsWith(acceptedPrefix +
            JSON.stringify([sessionId, account, ideaId]).slice(0, -1) + ',')) storage.removeItem(key);
        }
      } catch { /* Storage can be denied. */ }
    },
    clear() {
      unavailableScopes.clear();
      try {
        const storage = getStorage();
        for (let index = storage.length - 1; index >= 0; index--) {
          const key = storage.key(index);
          if (key?.startsWith(prefix) || key?.startsWith(acceptedPrefix)) storage.removeItem(key);
        }
      } catch { /* Storage can be denied. */ }
    }
  };
}
export type RecoveryStorage = ReturnType<typeof createRecoveryStorage>;
