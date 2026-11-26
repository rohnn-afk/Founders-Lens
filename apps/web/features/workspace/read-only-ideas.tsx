'use client';

import { SignOutButton, useAuth } from '@clerk/nextjs';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Idea, SessionSource } from './contracts';
import { createIdeaCommandController } from './create-controller';
import { IdeaEditForm } from './idea-edit-form';
import { createLocalConversationApi } from './local-conversation-api';
import { createRecoveryStorage } from './submission-recovery-storage';
import styles from './workspace.module.css';
import { WorkspaceShell } from './workspace-shell';
import { WorkspaceProvider } from './workspace-provider';

import { workspaceEndpoints } from './endpoints';

const { origin } = workspaceEndpoints();

/** Clear opaque recovery references before Clerk redirects away from the shell. */
export function WorkspaceSignOut() {
  return <span onClickCapture={() => createRecoveryStorage(() => window.sessionStorage, 300_000).clear()}>
    <SignOutButton redirectUrl="/sign-in"><button type="button">Sign out</button></SignOutButton>
  </span>;
}
type View = { kind: 'loading' | 'unavailable' | 'authentication-rejected' | 'denied' | 'error' } | { kind: 'ready'; ideas: Idea[]; cursor: string | null; conversations: boolean };

function SessionExpired() {
  return <div className={styles['feedback']}>
    <p role="alert">Your session has ended. Sign in to reopen your workspace.</p>
    <Link href="/sign-in" prefetch={false}>Sign in</Link>
  </div>;
}

/** Remount per verified browser session so a previous session's list cannot reappear. */
export function ReadOnlyIdeas() {
  const { isLoaded, userId, sessionId, getToken } = useAuth();
  if (!isLoaded) return <p role="status">Checking your session…</p>;
  if (!userId || !sessionId) {
    return <SessionExpired />;
  }
  return <IdeasForSession key={JSON.stringify([userId, sessionId])} account={userId} getToken={getToken} />;
}

/** Bind the existing nested workspace views to one Clerk session lifetime. */
export function LocalWorkspace({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { isLoaded, userId, sessionId, getToken } = useAuth();
  if (pathname === '/app') return <WorkspaceShell accountAction={isLoaded && sessionId ? <WorkspaceSignOut /> : undefined}>
    <ReadOnlyIdeas />
  </WorkspaceShell>;
  if (!isLoaded || !userId || !sessionId) return <WorkspaceShell>
    <h1>Workspace</h1>
    {isLoaded ? <SessionExpired /> : <p role="status">Checking your session...</p>}
  </WorkspaceShell>;
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
  const readOnly = origin.startsWith('https://');
  const pathname = usePathname();
  const conversationId = readOnly ? undefined : /\/conversations\/([a-f0-9-]+)$/.exec(pathname)?.[1];
  const [capability, setCapability] = useState<{ id: string; permissions: { generation: boolean; save: boolean } | null }>();
  const [revision, retryCapability] = useState(0);
  useEffect(() => {
    if (!conversationId) return;
    const controller = new AbortController();
    void adapters.conversationPermissions(conversationId, controller.signal).then(permissions => {
      if (!controller.signal.aborted) setCapability({ id: conversationId, permissions });
    }).catch(() => { if (!controller.signal.aborted) setCapability({ id: conversationId, permissions: null }); });
    return () => controller.abort();
  }, [adapters, conversationId, revision]);
  const session = useMemo<SessionSource>(() => ({ getSnapshot: () => ({ localAccountId: account }), subscribe: () => () => {},
    async revalidate() { if (!await tokenSource.current()) throw new Error('Session unavailable'); } }), [account]);
  // A pending or failed capability read must never offer a different write action.
  const resolved = capability?.id === conversationId ? capability?.permissions : undefined;
  if (conversationId && !resolved) {
    return <WorkspaceShell accountAction={<WorkspaceSignOut />}>
      <h1>Conversation</h1>
      {resolved === null ? <>
        <p className={styles['feedback']} role="alert">The conversation could not be opened.</p>
        <button type="button" onClick={() => { setCapability(undefined); retryCapability(value => value + 1); }}>Retry</button>
      </> : <p className={styles['feedback']} role="status">Opening conversation...</p>}
    </WorkspaceShell>;
  }
  return <WorkspaceProvider readOnly={readOnly} canSaveMessages={!readOnly && resolved?.save === true}
    accountAction={<WorkspaceSignOut />} session={session} api={adapters.api} savedMessages={adapters.savedMessages} recoverySessionId={sessionId}
    {...(conversationId && resolved?.generation &&
      { messageApi: adapters.messageApi, recoveryTtl: 300_000 })}>{children}</WorkspaceProvider>;
}

function IdeasForSession({ account, getToken }: { account: string; getToken: () => Promise<string | null> }) {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [request, setRequest] = useState<{ cursor: string | null }>({ cursor: null });
  const previousPage = useRef<Idea[]>([]);
  const activeRead = useRef<AbortController | null>(null);
  const latestToken = useRef(getToken);
  const [canCreate, setCanCreate] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [savedEdit, setSavedEdit] = useState(false);
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [creation, setCreation] = useState<'idle' | 'pending' | 'uncertain' | 'rejected' | 'blocked' | 'conflict'>('idle');
  const writeLifetime = useRef<AbortController | null>(null);
  const transport = useMemo(() => createLocalConversationApi(() => latestToken.current()), []);
  const commands = useMemo(() => createIdeaCommandController(transport.api, scope => !scope.signal.aborted), [transport]);
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
        const { reply, canCreate, canEdit, conversations } = await transport.listOwnedIdeas(request.cursor, controller.signal);
        controller.signal.throwIfAborted();
        if (reply.status === 401 || reply.status === 403) {
          // A revoked session may still look signed in to the SDK.
          writeLifetime.current?.abort();
          writeLifetime.current = new AbortController();
          commands.clear();
          setTitle('');
          setSummary('');
          setCreation('idle');
        }
        if (reply.status !== 200) {
          previousPage.current = [];
          setCanCreate(false);
          setCanEdit(false);
          setView({ kind: reply.status === 401 ? 'authentication-rejected' : reply.status === 403 ? 'denied' :
            reply.status === 404 || reply.status === 503 ? 'unavailable' : 'error' });
          return;
        }
        setCanCreate(canCreate);
        setCanEdit(canEdit);
        setView({ kind: 'ready', ideas: [...previousPage.current, ...reply.data.items], cursor: reply.data.page.nextCursor,
          conversations });
        previousPage.current = [];
      } catch {
        if (!controller.signal.aborted) {
          previousPage.current = [];
          setCanCreate(false);
          setCanEdit(false);
          setView({ kind: 'error' });
        }
      }
    }
    void load();
    return () => controller.abort();
  }, [request, commands, transport]);

  function load(cursor: string | null, previous: Idea[] = []) {
    setEditingId(null);
    setView({ kind: 'loading' });
    previousPage.current = previous;
    setRequest({ cursor });
  }
  function editDenied(status: 401 | 403) {
    activeRead.current?.abort();
    writeLifetime.current?.abort();
    writeLifetime.current = new AbortController();
    commands.clear();
    previousPage.current = [];
    setTitle('');
    setSummary('');
    setCreation('idle');
    setCanCreate(false);
    setCanEdit(false);
    setEditingId(null);
    setView({ kind: status === 401 ? 'authentication-rejected' : 'denied' });
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
      setView({ kind: result.kind === 'signed-out' ? 'authentication-rejected' : 'denied' });
      previousPage.current = [];
      if (result.kind === 'signed-out') { setTitle(''); setSummary(''); }
      setCreation('blocked');
    } else setCreation(result.kind);
  }
  const retryPending = commands.ideaUncertain();
  return <>
    <div className={styles['pageHeader']}>
      <h1>Your ideas</h1>
      <p>Review your idea context and open saved conversations when available.</p>
    </div>
    {view.kind === 'ready' && origin.startsWith('https://') && <p className={styles['feedback']}>This workspace is read-only.</p>}
    <div className={styles['overview']}>
      <section aria-label="Owned ideas">
        {savedEdit && <p role="status">Idea updated.</p>}
        {view.kind === 'loading' && <p className={styles['feedback']} role="status">Loading ideas…</p>}
        {view.kind === 'authentication-rejected' && <>
          <p className={styles['feedback']} role="alert">The workspace could not verify your session.</p>
          <button type="button" onClick={() => load(null)}>Retry</button>
        </>}
        {view.kind === 'denied' && <p className={styles['feedback']} role="alert">This account cannot access the workspace.</p>}
        {(view.kind === 'unavailable' || view.kind === 'error') && <><p className={styles['feedback']} role="alert">
          {view.kind === 'unavailable' ? 'Workspace data is unavailable.' : 'We could not load your ideas.'}
        </p>
          <button type="button" onClick={() => load(null)}>Retry</button></>}
        {creation === 'blocked' && <p role="alert">You do not currently have access to save ideas.</p>}
        {view.kind === 'ready' && (view.ideas.length === 0 ? <p className={styles['feedback']} role="status">You don’t have any ideas yet.{canCreate && ' Save an idea to start a conversation.'}</p> :
          <ul className={styles['list']}>{view.ideas.map(idea => <li key={idea.id}><h2>{idea.title}</h2>{idea.summary && <p>{idea.summary}</p>}
            {idea.status === 'ARCHIVED' && <p>Archived</p>}
            {canEdit && idea.status === 'ACTIVE' && (editingId === idea.id
              ? <IdeaEditForm idea={idea} edit={transport.editIdea} denied={editDenied} reload={() => load(null)}
                close={() => setEditingId(null)} saved={() => { setSavedEdit(true); load(null); }} />
              : <button type="button" onClick={() => { setSavedEdit(false); setEditingId(idea.id); }}>Edit {idea.title}</button>)}
            {view.conversations && idea.status === 'ACTIVE' && <Link prefetch={false} aria-label={`Open conversations for ${idea.title}`}
              href={'/app/ideas/' + encodeURIComponent(idea.id) + '/think'}>Open conversations</Link>}</li>)}</ul>)}
        {view.kind === 'ready' && view.cursor && <button type="button" onClick={() => load(view.cursor, view.ideas)}>
          Load more ideas
        </button>}
      </section>
      {(view.kind === 'ready' && (canCreate || creation === 'uncertain')) && <form className={styles['panel']} onSubmit={event => { event.preventDefault(); void create(); }}>
        <fieldset className={styles['form']} disabled={creation === 'pending' || retryPending}>
          <legend>New idea</legend>
          <label htmlFor="idea-title">Title</label>
          <input id="idea-title" required value={title} onChange={event => setTitle(event.target.value)} />
          <label htmlFor="idea-summary">Summary (optional)</label>
          <textarea id="idea-summary" value={summary} onChange={event => setSummary(event.target.value)} />
          <button className={styles['primary']} type="submit">Save idea</button>
        </fieldset>
        {creation === 'pending' && <p role="status">Saving idea…</p>}
        {retryPending && <><p role="status">The save could not be confirmed.</p>
          <button type="button" onClick={() => void create(true)}>Retry original idea</button></>}
        {creation === 'rejected' && <p role="alert">Enter a nonblank title up to 200 characters and a summary up to 5,000 characters.</p>}
        {creation === 'conflict' && <p role="alert">This save conflicts with an earlier request. Check your ideas before saving again.</p>}
      </form>}
    </div>
  </>;
}
