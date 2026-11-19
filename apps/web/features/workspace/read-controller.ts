// Coordinates scoped, in-memory reads for the chooser and nested routes.
// The provider opens and invalidates scopes as identity or navigation changes.
import type { Idea, Reply, Scope, WorkspaceApi } from './contracts';

export type ReadResult<T> = { kind: 'ready'; data: T } |
  { kind: 'signed-out' | 'blocked' | 'missing' | 'error' | 'stale' };

export function createReadController() {
  // A session generation identifies one identity lifetime, including a
  // same-account re-sign-in. A route generation identifies one visit.
  let sessionGeneration = 0;
  let routeGeneration = 0;
  let account: string | null = null;
  let abort = new AbortController();
  // A cache is a local copy of server results. Invalidation removes that copy
  // when its identity or resource context can no longer be trusted.
  const cache = new Map<string, { generation: number; data: unknown }>();
  function enter(nextAccount: string | null, sessionChanged = false): Scope | null {
    if (account !== nextAccount || sessionChanged) {
      sessionGeneration++;
      cache.clear();
    }
    routeGeneration++;
    account = nextAccount;
    // AbortController asks transport to cancel. Generation checks also catch
    // a race where an old request completes despite cancellation.
    abort.abort();
    abort = new AbortController();
    return account ? { account, sessionGeneration, routeGeneration, signal: abort.signal } : null;
  }
  function isCurrent(scope: Scope) {
    return account === scope.account && sessionGeneration === scope.sessionGeneration &&
      routeGeneration === scope.routeGeneration && !scope.signal.aborted;
  }
  async function read<T>(scope: Scope, key: readonly (string | null)[],
    request: (signal: AbortSignal) => Promise<Reply<T>>, preferCache = false): Promise<ReadResult<T>> {
    if (!isCurrent(scope)) return { kind: 'stale' };
    const cacheKey = JSON.stringify([scope.account, ...key]);
    const cached = cache.get(cacheKey);
    // A page revisit inside the current route can reuse an accepted read.
    // Navigation and browser restoration open a new generation and must recheck.
    if (preferCache && cached?.generation === scope.routeGeneration) {
      return { kind: 'ready', data: cached.data as T };
    }
    try {
      // Re-entry always gets fresh evidence. The cache stores the last
      // accepted result for this scope and never authorizes a route by itself.
      const reply = await request(scope.signal);
      if (!isCurrent(scope)) return { kind: 'stale' };
      if (reply.status === 200) {
        cache.set(cacheKey, { generation: scope.routeGeneration, data: reply.data });
        if (cache.size > 64) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        return { kind: 'ready', data: reply.data };
      }
      cache.clear();
      if (reply.status === 401) return { kind: 'signed-out' };
      if (reply.status === 403) return { kind: 'blocked' };
      return { kind: reply.status === 404 ? 'missing' : 'error' };
    } catch {
      if (!isCurrent(scope)) return { kind: 'stale' };
      cache.delete(cacheKey);
      return { kind: 'error' };
    }
  }
  return { enter, isCurrent, read };
}
export type ReadController = ReturnType<typeof createReadController>;

async function ownedIdea(reads: ReadController, api: WorkspaceApi, scope: Scope, id: string): Promise<ReadResult<Idea>> {
  const result = await reads.read(scope, ['idea', id], signal => api.idea(id, signal));
  if (result.kind !== 'ready') return result;
  return result.data.id === id && (result.data.status === 'ACTIVE' || result.data.status === 'ARCHIVED')
    ? result : { kind: 'missing' };
}

export async function readThink(reads: ReadController, api: WorkspaceApi, scope: Scope, id: string, cursor: string | null) {
  const idea = await ownedIdea(reads, api, scope, id);
  if (idea.kind !== 'ready') return idea;
  const conversations = await reads.read(scope, ['conversations', id, cursor], signal => api.conversations(id, cursor, signal));
  if (conversations.kind !== 'ready') return conversations;
  if (conversations.data.items.some(item => item.ideaId !== id)) return { kind: 'missing' } as const;
  return { kind: 'ready', data: { idea: idea.data, conversations: conversations.data } } as const;
}

export async function readConversation(reads: ReadController, api: WorkspaceApi, scope: Scope, ideaId: string, id: string) {
  const idea = await ownedIdea(reads, api, scope, ideaId);
  if (idea.kind !== 'ready') return idea;
  const conversation = await reads.read(scope, ['conversation', ideaId, id], signal => api.conversation(id, signal));
  if (conversation.kind !== 'ready') return conversation;
  // A valid conversation ID can still belong to a different idea.
  if (conversation.data.ideaId !== ideaId || conversation.data.id !== id) return { kind: 'missing' } as const;
  return { kind: 'ready', data: { idea: idea.data, conversation: conversation.data } } as const;
}
