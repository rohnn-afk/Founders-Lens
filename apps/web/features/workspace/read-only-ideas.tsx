'use client';

import { SignOutButton, useAuth } from '@clerk/nextjs';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Idea, IdeaCreate, Page, Reply, SessionSource } from './contracts';
import { createIdeaCommandController } from './create-controller';
import { createLocalConversationApi } from './local-conversation-api';
import { createRecoveryStorage } from './submission-recovery-storage';
import { WorkspaceProvider } from './workspace-provider';

const endpoint = 'http://127.0.0.1:3001/api/v1/ideas';

/** Clear opaque recovery references before Clerk redirects away from the shell. */
export function WorkspaceSignOut() {
  return <span onClickCapture={() => createRecoveryStorage(() => window.sessionStorage, 300_000).clear()}>
    <SignOutButton redirectUrl="/sign-in"><button type="button">Sign out</button></SignOutButton>
  </span>;
}
type View = { kind: 'loading' | 'unavailable' } | { kind: 'ready'; ideas: Idea[]; cursor: string | null; conversations: boolean };

/** Decode the list projection before rendering any private values. */
function ideaPage(value: unknown): Page<Idea> {
  const page = value as Partial<Page<Idea>> | null;
  if (!page || !Array.isArray(page.items) || !page.page || typeof page.page.hasMore !== 'boolean' ||
    (page.page.hasMore ? typeof page.page.nextCursor !== 'string' || !page.page.nextCursor : page.page.nextCursor !== null) ||
    !page.items.every(item => item && typeof item.id === 'string' && typeof item.title === 'string' &&
      (item.summary == null || typeof item.summary === 'string') && typeof item.createdAt === 'string' &&
      typeof item.updatedAt === 'string' && Number.isInteger(item.version) &&
      (item.status === 'ACTIVE' || item.status === 'ARCHIVED'))) throw new Error('Invalid ideas response');
  return page as Page<Idea>;
}

async function sendIdea(getToken: () => Promise<string | null>, body: Readonly<IdeaCreate>, key: string,
  signal: AbortSignal): Promise<Reply<Idea>> {
  if (window.location.origin !== 'http://127.0.0.1:3000') return { status: 403 };
  const token = await getToken();
  signal.throwIfAborted();
  if (!token) return { status: 401 };
  const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body), credentials: 'omit',
  cache: 'no-store', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]) });
  switch (response.status) {
    case 201: return { status: 201, data: ideaPage({ items: [await response.json()],
      page: { nextCursor: null, hasMore: false } }).items[0]! };
    case 400: case 401: case 403: case 409: case 413: case 415: return { status: response.status };
    default: return { status: 503 };
  }
}

/** Remount per verified browser session so a previous session's list cannot reappear. */
export function ReadOnlyIdeas() {
  const { isLoaded, userId, sessionId, getToken } = useAuth();
  if (!isLoaded) return <p role="status">Checking your session…</p>;
  if (!userId || !sessionId) {
    return <p role="status">Workspace data is unavailable.</p>;
  }
  return <IdeasForSession key={JSON.stringify([userId, sessionId])} account={userId} getToken={getToken} />;
}

/** Bind the existing nested workspace views to one Clerk session lifetime. */
export function LocalWorkspace({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { isLoaded, userId, sessionId, getToken } = useAuth();
  if (pathname === '/app') return <ReadOnlyIdeas />;
  if (!isLoaded || !userId || !sessionId) return <p role="status">Workspace data is unavailable.</p>;
  return <LocalConversationSession key={JSON.stringify([userId, sessionId])} account={userId} sessionId={sessionId} getToken={getToken}>
    {children}
  </LocalConversationSession>;
}

function LocalConversationSession({ account, sessionId, getToken, children }: {
  account: string; sessionId: string; getToken: () => Promise<string | null>; children: ReactNode;
}) {
  const tokenSource = useRef(getToken);
  useEffect(() => { tokenSource.current = getToken; }, [getToken]);
  const adapters = useMemo(() => createLocalConversationApi(() => tokenSource.current()), []);
  const conversationId = /\/conversations\/([a-f0-9-]+)$/.exec(usePathname())?.[1];
  const [generationConversation, setGenerationConversation] = useState<string>();
  useEffect(() => {
    if (!conversationId) return;
    const controller = new AbortController();
    void adapters.generationEnabled(conversationId, controller.signal).then(enabled => {
      if (!controller.signal.aborted) setGenerationConversation(enabled ? conversationId : undefined);
    }).catch(() => { if (!controller.signal.aborted) setGenerationConversation(undefined); });
    return () => controller.abort();
  }, [adapters, conversationId]);
  const session = useMemo<SessionSource>(() => ({ getSnapshot: () => ({ localAccountId: account }), subscribe: () => () => {},
    async revalidate() { if (!await tokenSource.current()) throw new Error('Session unavailable'); } }), [account]);
  return <WorkspaceProvider session={session} api={adapters.api} savedMessages={adapters.savedMessages} recoverySessionId={sessionId}
    {...(conversationId && generationConversation === conversationId &&
      { messageApi: adapters.messageApi, recoveryTtl: 300_000 })}>{children}</WorkspaceProvider>;
}

function IdeasForSession({ account, getToken }: { account: string; getToken: () => Promise<string | null> }) {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [request, setRequest] = useState<{ cursor: string | null }>({ cursor: null });
  const previousPage = useRef<Idea[]>([]);
  const activeRead = useRef<AbortController | null>(null);
  const latestToken = useRef(getToken);
  const [canCreate, setCanCreate] = useState(false);
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [creation, setCreation] = useState<'idle' | 'pending' | 'uncertain' | 'rejected' | 'blocked' | 'conflict'>('idle');
  const writeLifetime = useRef<AbortController | null>(null);
  const commands = useMemo(() => createIdeaCommandController({
    createIdea: (body, key, signal) => sendIdea(latestToken.current, body, key, signal)
  }, scope => !scope.signal.aborted), []);
  useEffect(() => {
    const lifetime = new AbortController();
    writeLifetime.current = lifetime;
    return () => { writeLifetime.current?.abort(); commands.clear(); };
  }, [commands]);
  useEffect(() => { latestToken.current = getToken; }, [getToken]);
  useEffect(() => {
    const controller = new AbortController();
    activeRead.current = controller;
    async function load() {
      try {
        if (window.location.origin !== 'http://127.0.0.1:3000') throw new Error('Unexpected workspace origin');
        const token = await latestToken.current();
        controller.signal.throwIfAborted();
        if (!token) throw new Error('Session unavailable');
        const url = new URL(endpoint);
        if (request.cursor) url.searchParams.set('cursor', request.cursor);
        const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, credentials: 'omit',
          cache: 'no-store', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]) });
        controller.signal.throwIfAborted();
        if (response.status === 401) {
          // A revoked session may still look signed in to the SDK.
          writeLifetime.current?.abort();
          writeLifetime.current = new AbortController();
          commands.clear();
          setTitle('');
          setSummary('');
          setCreation('idle');
        }
        if (response.status !== 200) throw new Error('Workspace unavailable');
        const data = ideaPage(await response.json());
        controller.signal.throwIfAborted();
        setCanCreate(response.headers.get('X-Workspace-Idea-Creation') === 'enabled');
        setView({ kind: 'ready', ideas: [...previousPage.current, ...data.items], cursor: data.page.nextCursor,
          conversations: response.headers.get('X-Workspace-Conversations') === 'enabled' });
        previousPage.current = [];
      } catch {
        if (!controller.signal.aborted) {
          previousPage.current = [];
          setCanCreate(false);
          setView({ kind: 'unavailable' });
        }
      }
    }
    void load();
    return () => controller.abort();
  }, [request, commands]);

  function load(cursor: string | null, previous: Idea[] = []) {
    setView({ kind: 'loading' });
    previousPage.current = previous;
    setRequest({ cursor });
  }
  async function create(retry = false) {
    const signal = writeLifetime.current?.signal;
    if (!signal || signal.aborted || creation === 'pending') return;
    if (!retry && (!title.trim() || Array.from(title).length > 200 || Array.from(summary).length > 5000)) {
      setCreation('rejected');
      return;
    }
    setCreation('pending');
    const result = await commands.submitIdea({ account, sessionGeneration: 0, routeGeneration: 0, signal },
      retry ? undefined : { title, ...(summary ? { summary } : {}) });
    if (signal.aborted || result.kind === 'stale' || result.kind === 'pending') return;
    if (result.kind === 'created') {
      setTitle('');
      setSummary('');
      setCreation('idle');
      load(null);
    } else if (result.kind === 'signed-out' || result.kind === 'blocked') {
      activeRead.current?.abort();
      setCanCreate(false);
      setView({ kind: 'unavailable' });
      previousPage.current = [];
      if (result.kind === 'signed-out') { setTitle(''); setSummary(''); }
      setCreation('blocked');
    } else setCreation(result.kind);
  }
  const retryPending = commands.ideaUncertain();
  return <section aria-labelledby="owned-ideas">
    <h2 id="owned-ideas">Your ideas</h2>
    {(canCreate || creation === 'uncertain') && <form onSubmit={event => { event.preventDefault(); void create(); }}>
      <fieldset disabled={creation === 'pending' || retryPending}>
        <legend>New idea</legend>
        <label htmlFor="idea-title">Title</label>
        <input id="idea-title" required value={title} onChange={event => setTitle(event.target.value)} />
        <label htmlFor="idea-summary">Summary (optional)</label>
        <textarea id="idea-summary" value={summary} onChange={event => setSummary(event.target.value)} />
        <button type="submit">Save idea</button>
      </fieldset>
      {creation === 'pending' && <p role="status">Saving idea…</p>}
      {retryPending && <><p role="status">The save could not be confirmed.</p>
        <button type="button" onClick={() => void create(true)}>Retry original idea</button></>}
      {creation === 'rejected' && <p role="alert">Enter a nonblank title up to 200 characters and a summary up to 5,000 characters.</p>}
      {creation === 'conflict' && <p role="alert">This save conflicts with an earlier request. Check your ideas before saving again.</p>}
    </form>}
    {view.kind === 'loading' && <p role="status">Loading ideas…</p>}
    {view.kind === 'unavailable' && <><p role="status">Workspace data is unavailable.</p>
      <button type="button" onClick={() => load(null)}>Retry</button></>}
    {creation === 'blocked' && <p role="alert">You do not currently have access to save ideas.</p>}
    {view.kind === 'ready' && (view.ideas.length === 0 ? <p role="status">You don’t have any ideas yet.</p> :
      <ul>{view.ideas.map(idea => <li key={idea.id}><strong>{idea.title}</strong>{idea.summary && <p>{idea.summary}</p>}
        {view.conversations && idea.status === 'ACTIVE' && <Link prefetch={false} aria-label={`Open conversations for ${idea.title}`}
          href={'/app/ideas/' + encodeURIComponent(idea.id) + '/think'}>Open conversations</Link>}</li>)}</ul>)}
    {view.kind === 'ready' && view.cursor && <button type="button" onClick={() => load(view.cursor, view.ideas)}>
      Load more ideas
    </button>}
  </section>;
}
