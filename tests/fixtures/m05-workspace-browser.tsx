// Temporary Next.js layout for the opt-in browser journey. The loopback test
// proxy attaches synthetic credentials server-side; this adapter has none.
'use client';

import type { ReactNode } from 'react';
import type { Generation, GenerationReply, MessageApi, Reply, WorkspaceApi } from '../../features/workspace/contracts';
import { WorkspaceProvider } from '../../features/workspace/workspace-provider';

const account = '__M05_FIXTURE_ACCOUNT__';
const snapshot = { localAccountId: account };
const session = { getSnapshot: () => snapshot, subscribe: () => () => {},
  async revalidate() {} };
const statuses = ['PENDING', 'RUNNING', 'CANCEL_REQUESTED', 'COMPLETED', 'FAILED', 'CANCELLED'];
const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function request(path: string, signal: AbortSignal, method = 'GET', key?: string, body?: unknown) {
  const response = await fetch('/__m05/api' + path, { method, signal, cache: 'no-store',
    headers: { ...(key ? { 'Idempotency-Key': key } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data: unknown = await response.json();
  if (!data || typeof data !== 'object') throw new Error('Invalid fixture response');
  const retryAfter = response.headers.get('Retry-After');
  const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000
    : retryAfter ? Math.max(0, Date.parse(retryAfter) - Date.now()) : undefined;
  return { status: response.status, data, retryAfterMs };
}
async function read<T>(path: string, signal: AbortSignal): Promise<Reply<T>> {
  const result = await request(path, signal);
  return result as Reply<T>;
}
async function generation(path: string, signal: AbortSignal, method?: string, key?: string, body?: unknown): Promise<GenerationReply> {
  const { status, data, retryAfterMs } = await request(path, signal, method, key, body);
  if (status === 200 || status === 202) {
    const value = data as Partial<Generation>;
    if (typeof value.id !== 'string' || !id.test(value.id) || typeof value.conversationId !== 'string' ||
      !id.test(value.conversationId) || typeof value.triggerMessageId !== 'string' || !id.test(value.triggerMessageId) ||
      typeof value.status !== 'string' || !statuses.includes(value.status) ||
      typeof value.selected !== 'boolean' || typeof value.createdAt !== 'string') throw new Error('Invalid generation reply');
    return { status, data: value as Generation };
  }
  if (![400, 401, 403, 404, 409, 413, 415, 429, 500, 503].includes(status)) throw new Error('Unexpected fixture status');
  return { status, retryAfterMs, error: 'error' in data ? data.error : undefined } as GenerationReply;
}

const workspace: WorkspaceApi = {
  ideas: (_cursor, signal) => read('/ideas', signal),
  idea: (idea, signal) => read('/ideas/' + idea, signal),
  conversations: (idea, _cursor, signal) => read('/ideas/' + idea + '/conversations', signal),
  conversation: (conversation, signal) => read('/conversations/' + conversation, signal),
  async createIdea() { return { status: 403 }; },
  async createConversation() { return { status: 403 }; }
};
const messages: MessageApi = {
  async submit(conversation, body, key, signal) {
    const reply = await request('/conversations/' + conversation + '/messages', signal, 'POST', key, body);
    return reply as Awaited<ReturnType<MessageApi['submit']>>;
  },
  correlate: (conversation, submission, signal) => read('/conversations/' + conversation + '/submissions/' + submission, signal),
  history: (conversation, cursor, signal) =>
    read('/conversations/' + conversation + '/messages' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), signal),
  generation: {
    status: (attempt, signal) => generation('/generations/' + attempt, signal),
    cancel: (attempt, key, signal) => generation('/generations/' + attempt + '/cancel', signal, 'POST', key),
    regenerate: (conversation, triggerMessageId, key, signal) =>
      generation('/conversations/' + conversation + '/regenerations', signal, 'POST', key, { triggerMessageId })
  }
};

export default function FixtureLayout({ children }: { children: ReactNode }) {
  return <WorkspaceProvider api={workspace} session={session} messageApi={messages} recoveryTtl={600_000}>
    {children}
  </WorkspaceProvider>;
}
