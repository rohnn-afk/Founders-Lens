// Browser-side workspace contracts. Views and controllers share these wire
// shapes while the application supplies an API implementation at composition.
// Entity versions support optimistic concurrency: a future edit can require
// the version it read before writing. The current workspace only creates rows.
export type Idea = {
  id: string; title: string; summary?: string | null; version: number;
  status: 'ACTIVE' | 'ARCHIVED' | 'DELETION_REQUESTED' | 'PURGING' | 'DELETED';
  createdAt: string; updatedAt: string;
};
export type Conversation = {
  id: string; ideaId: string; title?: string | null; status: 'ACTIVE' | 'ARCHIVED';
  proactiveResearch: boolean; version: number; createdAt?: string;
};
export type Page<T> = { items: T[]; page: { nextCursor: string | null; hasMore: boolean } };
export type IdeaCreate = { title: string; summary?: string };
export type ConversationCreate = { title?: string; proactiveResearch?: boolean };

// An adapter supplies decoded DTOs and HTTP failures. No credentials belong
// in view state or in the session snapshot used to scope this client.
export type Reply<T> = { status: 200 | 201; data: T } |
  { status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 500 | 503 };
export type Message = {
  id: string; conversationId: string; sequence: number; role: 'USER' | 'ASSISTANT'; content: string; createdAt: string;
};
export type Acceptance = { messageId: string; generationId: string; statusUrl: string; eventsUrl: string };
export type MessageBody = Readonly<{ content: string; clientSubmissionId: string }>;
export type MessageApi = {
  submit(id: string, body: MessageBody, key: string, signal: AbortSignal): Promise<
    { status: 202; data: Acceptance & { status: 'PENDING' } } | Extract<Reply<never>, { status: number; data?: never }>>;
  correlate(id: string, submissionId: string, signal: AbortSignal): Promise<Reply<Acceptance & { clientSubmissionId: string }>>;
  history(id: string, cursor: string | null, signal: AbortSignal): Promise<Reply<Page<Message>>>;
};
export interface WorkspaceApi {
  ideas(cursor: string | null, signal: AbortSignal): Promise<Reply<Page<Idea>>>;
  idea(id: string, signal: AbortSignal): Promise<Reply<Idea>>;
  conversations(id: string, cursor: string | null, signal: AbortSignal): Promise<Reply<Page<Conversation>>>;
  conversation(id: string, signal: AbortSignal): Promise<Reply<Conversation>>;
  createIdea(body: Readonly<IdeaCreate>, key: string, signal: AbortSignal): Promise<Reply<Idea>>;
  createConversation(id: string, body: Readonly<ConversationCreate>, signal: AbortSignal): Promise<Reply<Conversation>>;
}
export type WorkspaceSession = Readonly<{ localAccountId: string }>;
export interface SessionSource {
  getSnapshot(): WorkspaceSession | null;
  subscribe(listener: () => void): () => void;
  revalidate(): Promise<void>;
}
export type Scope = { account: string; sessionGeneration: number; routeGeneration: number; signal: AbortSignal };
