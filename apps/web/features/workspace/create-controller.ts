// Owns creation intent and uncertainty separately from React forms.
// Workspace commands use an injected API and the current request scope.
import type { Conversation, ConversationCreate, Idea, IdeaCreate, Reply, Scope, WorkspaceApi } from './contracts';

export type CreateResult<T> = { kind: 'created'; data: T } |
  { kind: 'pending' | 'uncertain' | 'rejected' | 'signed-out' | 'blocked' | 'stale' };

export function createCommandController(api: WorkspaceApi, isCurrent: (scope: Scope) => boolean,
  makeKey = () => crypto.randomUUID()) {
  let ideaIntent: { session: number; account: string; body: Readonly<IdeaCreate>; key: string } | undefined;
  let ideaPending = false;
  const conversationAttempts = new Map<string, 'pending' | 'uncertain'>();
  let generation = 0;

  function clear() {
    generation++;
    ideaIntent = undefined;
    ideaPending = false;
    conversationAttempts.clear();
  }

  async function submitIdea(scope: Scope, body?: IdeaCreate): Promise<CreateResult<Idea>> {
    if (!isCurrent(scope)) return { kind: 'stale' };
    if (ideaPending) return { kind: 'pending' };
    if (ideaIntent && (ideaIntent.session !== scope.sessionGeneration || ideaIntent.account !== scope.account)) return { kind: 'stale' };
    if (body && ideaIntent) return { kind: 'uncertain' };
    if (body) {
      // Idempotency lets the server recognize the same logical create. Freeze
      // both the payload and key so an explicit retry cannot change the intent.
      ideaIntent = { session: scope.sessionGeneration, account: scope.account, body: Object.freeze({ ...body }), key: makeKey() };
    }
    const intent = ideaIntent;
    if (!intent) return { kind: 'rejected' };
    ideaPending = true;
    const attemptGeneration = generation;
    const reply = await send(() => api.createIdea(intent.body, intent.key, scope.signal));
    if (attemptGeneration !== generation) return { kind: 'stale' };
    ideaPending = false;
    if (!isCurrent(scope)) return { kind: 'stale' };
    const result = creationResult(reply);
    if (result.kind !== 'uncertain') ideaIntent = undefined;
    return result;
  }

  async function submitConversation(scope: Scope, ideaId: string, body: ConversationCreate): Promise<CreateResult<Conversation>> {
    if (!isCurrent(scope)) return { kind: 'stale' };
    const previous = conversationAttempts.get(ideaId);
    if (previous) return { kind: previous };
    conversationAttempts.set(ideaId, 'pending');
    const attemptGeneration = generation;
    const reply = await send(() => api.createConversation(ideaId, Object.freeze({ ...body }), scope.signal));
    if (attemptGeneration !== generation) return { kind: 'stale' };
    const result = reply.status === 201 && reply.data.ideaId !== ideaId
      ? { kind: 'uncertain' as const } : creationResult(reply);
    // An unkeyed POST can commit before its reply is lost. Keep this intent
    // blocked even after a reconciliation read returns an empty list.
    if (result.kind === 'uncertain' || !isCurrent(scope)) conversationAttempts.set(ideaId, 'uncertain');
    else conversationAttempts.delete(ideaId);
    return isCurrent(scope) ? result : { kind: 'stale' };
  }

  return { clear, submitIdea, submitConversation,
    ideaUncertain: () => Boolean(ideaIntent && !ideaPending),
    conversationState: (ideaId: string) => conversationAttempts.get(ideaId) };
}

async function send<T>(request: () => Promise<Reply<T>>): Promise<Reply<T>> {
  try { return await request(); } catch { return { status: 503 }; }
}
function creationResult<T>(reply: Reply<T>): CreateResult<T> {
  if (reply.status === 201) return { kind: 'created', data: reply.data };
  if (reply.status === 401) return { kind: 'signed-out' };
  if (reply.status === 403) return { kind: 'blocked' };
  if (reply.status === 429 || reply.status === 500 || reply.status === 503) return { kind: 'uncertain' };
  return { kind: 'rejected' };
}
