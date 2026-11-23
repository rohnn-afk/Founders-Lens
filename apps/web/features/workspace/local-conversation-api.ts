// Browser transport for the opted-in local workspace. Clerk credentials exist
// only in the request, and uncertain saves retain their original in-memory intent.
import type { Acceptance, Conversation, Generation, Idea, Message, MessageApi, MessageBody, Page, Reply, SavedMessageApi, WorkspaceApi } from './contracts';

const origin = 'http://127.0.0.1:3000';
const endpoint = 'http://127.0.0.1:3001/api/v1';
const ideaPath = (id: string) => '/ideas/' + encodeURIComponent(id);
const conversationPath = (id: string) => '/conversations/' + encodeURIComponent(id);
const withCursor = (path: string, cursor: string | null) => cursor ? path + '?cursor=' + encodeURIComponent(cursor) : path;

function page<T>(value: Page<T>, item: (value: T) => boolean): Page<T> {
  if (!Array.isArray(value?.items) || !value.items.every(item) || typeof value.page?.hasMore !== 'boolean' ||
    (value.page.hasMore ? typeof value.page.nextCursor !== 'string' || !value.page.nextCursor : value.page.nextCursor !== null)) {
    throw new Error('Invalid workspace page');
  }
  return value;
}
const idea = (value: Idea, id?: string) => typeof value?.id === 'string' && (!id || id === value.id) &&
  typeof value.title === 'string' && ['ACTIVE', 'ARCHIVED'].includes(value.status);
const conversation = (value: Conversation, ideaId?: string) => typeof value?.id === 'string' &&
  typeof value.ideaId === 'string' && (!ideaId || value.ideaId === ideaId) &&
  (value.title == null || typeof value.title === 'string') && ['ACTIVE', 'ARCHIVED'].includes(value.status);
const message = (value: Message, id: string) => typeof value?.id === 'string' && value.conversationId === id &&
  Number.isSafeInteger(value.sequence) && value.sequence > 0 && ['USER', 'ASSISTANT'].includes(value.role) &&
  typeof value.content === 'string' && typeof value.createdAt === 'string';

/** Construct session-scoped P8 and opt-in generation transports. */
export function createLocalConversationApi(getToken: () => Promise<string | null>, makeKey = () => crypto.randomUUID()) {
  async function request<T>(path: string, signal: AbortSignal, decode: (value: T) => T,
    command?: { body: unknown; key?: string; accepted?: boolean }, headers?: (headers: Headers) => void): Promise<Reply<T>> {
    if (window.location.origin !== origin) return { status: 403 };
    const token = await getToken();
    signal.throwIfAborted();
    if (!token) return { status: 401 };
    const response = await fetch(endpoint + path, { method: command ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, ...(command && { 'Content-Type': 'application/json' }),
        ...(command?.key && { 'Idempotency-Key': command.key }) }, ...(command && { body: JSON.stringify(command.body) }),
      credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]) });
    if (response.status === (command ? command.accepted ? 202 : 201 : 200)) {
      const data = decode(await response.json());
      if (signal.aborted) return { status: 503 };
      headers?.(response.headers);
      return { status: command ? 201 : 200, data };
    }
    const id = response.headers.get('X-Request-Id');
    const correlation = id && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
      ? { requestId: id } : {};
    // A closed mount returns a bare 404. It cannot settle a prior save intent.
    if (command?.key && response.status === 404 && !response.headers.get('Content-Type')?.includes('application/json')) {
      return { status: 503, ...correlation };
    }
    switch (response.status) {
      case 400: case 401: case 403: case 404: case 409: case 413: case 415: case 429: return { status: response.status, ...correlation };
      default: return { status: 503, ...correlation };
    }
  }
  function verify<T>(test: (value: T) => boolean) {
    return (value: T) => {
      if (!test(value)) throw new Error('Invalid workspace response');
      return value;
    };
  }
  const api: WorkspaceApi = {
    ideas: (cursor, signal) => request<Page<Idea>>(withCursor('/ideas', cursor), signal, v => page(v, item => idea(item))),
    idea: (id, signal) => request<Idea>(ideaPath(id), signal, verify(v => idea(v, id))),
    conversations: (id, cursor, signal) => request<Page<Conversation>>(withCursor(ideaPath(id) + '/conversations', cursor), signal,
      v => page(v, item => conversation(item, id))),
    conversation: (id, signal) => request<Conversation>(conversationPath(id), signal, verify(v => conversation(v) && v.id === id)),
    createConversation: (id, body, signal) => request<Conversation>(ideaPath(id) + '/conversations', signal,
      verify(v => conversation(v, id)), { body }),
    createIdea: (body, key, signal) => request<Idea>('/ideas', signal, verify(v => idea(v)), { body, key })
  };
  const intents = new Map<string, { body: MessageBody; key: string; sending: boolean }>();
  const savedMessages: SavedMessageApi = {
    history: (id, cursor, signal) => request<Page<Message>>(withCursor(conversationPath(id) + '/messages', cursor), signal,
      v => page(v, item => message(item, id))),
    pending: id => intents.get(id)?.body.content,
    clear: id => id === undefined ? intents.clear() : void intents.delete(id),
    async save(id, content, signal) {
      if (signal.aborted) return { status: 503 };
      let intent = intents.get(id);
      if (intent?.sending || (intent && content !== undefined)) return { status: 503 };
      if (content !== undefined) {
        intent = { body: Object.freeze({ content, clientSubmissionId: makeKey() }), key: makeKey(), sending: false };
        intents.set(id, intent);
      }
      if (!intent) return { status: 400 };
      intent.sending = true;
      try {
        const reply = await request<Message>(conversationPath(id) + '/messages/save', signal,
          verify(v => message(v, id) && v.role === 'USER' && v.content === intent.body.content), intent);
        if (reply.status !== 503 && reply.status !== 429 && intents.get(id) === intent) intents.delete(id);
        return reply;
      } catch { return { status: 503 }; }
      finally { intent.sending = false; }
    }
  };
  const messagePath = (id: string) => conversationPath(id) + '/messages';
  const validAcceptance = (value: Acceptance) => typeof value?.messageId === 'string' &&
    typeof value.generationId === 'string' && value.statusUrl === '/api/v1/generations/' + value.generationId &&
    value.eventsUrl === value.statusUrl + '/events';
  const messageApi: MessageApi = {
    history: savedMessages.history,
    async submit(id, body, key, signal) {
      const reply = await request<Acceptance & { status: 'PENDING' }>(messagePath(id), signal,
        verify(value => validAcceptance(value) && value.status === 'PENDING'), { body, key, accepted: true });
      if ('data' in reply) return reply.status === 201 ? { status: 202, data: reply.data } : { status: 503 };
      return reply;
    },
    correlate: (id, submissionId, signal) =>
      request<Acceptance & { clientSubmissionId: string }>(conversationPath(id) + '/submissions/' +
        encodeURIComponent(submissionId), signal, verify(value => validAcceptance(value) && value.clientSubmissionId === submissionId)),
    generation: { async status(id, signal) {
      const reply = await request<Generation>('/generations/' + encodeURIComponent(id), signal, verify(value =>
        value?.id === id && typeof value.conversationId === 'string' && typeof value.triggerMessageId === 'string' &&
        typeof value.selected === 'boolean' && typeof value.createdAt === 'string' &&
        ['PENDING', 'RUNNING', 'CANCEL_REQUESTED', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(value.status)));
      if ('data' in reply) return reply.status === 200 ? { status: 200, data: reply.data } : { status: 503 };
      return reply;
    } }
  };
  return { api, savedMessages, messageApi, async generationEnabled(id: string, signal: AbortSignal) {
    let enabled = false;
    await request<Conversation>(conversationPath(id), signal, verify(value => conversation(value) && value.id === id), undefined,
      headers => { enabled = headers.get('X-Workspace-Generation') === 'enabled'; });
    return enabled;
  } };
}
