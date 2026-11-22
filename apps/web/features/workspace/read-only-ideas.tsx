'use client';

import { useAuth } from '@clerk/nextjs';
import { useEffect, useRef, useState } from 'react';
import type { Idea, Page } from './contracts';

const endpoint = 'http://127.0.0.1:3001/api/v1/ideas';
type View = { kind: 'loading' | 'unavailable' } | { kind: 'ready'; ideas: Idea[]; cursor: string | null };

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

/** Remount per verified browser session so a previous session's list cannot reappear. */
export function ReadOnlyIdeas() {
  const { isLoaded, userId, sessionId, getToken } = useAuth();
  if (!isLoaded) return <p role="status">Checking your session…</p>;
  if (!userId || !sessionId) {
    return <p role="status">Workspace data is unavailable.</p>;
  }
  return <IdeasForSession key={JSON.stringify([userId, sessionId])} getToken={getToken} />;
}

function IdeasForSession({ getToken }: { getToken: () => Promise<string | null> }) {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [request, setRequest] = useState<{ cursor: string | null }>({ cursor: null });
  const previousPage = useRef<Idea[]>([]);
  const latestToken = useRef(getToken);
  useEffect(() => { latestToken.current = getToken; }, [getToken]);
  useEffect(() => {
    const controller = new AbortController();
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
        if (response.status !== 200) throw new Error('Workspace unavailable');
        const data = ideaPage(await response.json());
        controller.signal.throwIfAborted();
        setView({ kind: 'ready', ideas: [...previousPage.current, ...data.items], cursor: data.page.nextCursor });
        previousPage.current = [];
      } catch {
        if (!controller.signal.aborted) {
          previousPage.current = [];
          setView({ kind: 'unavailable' });
        }
      }
    }
    void load();
    return () => controller.abort();
  }, [request]);

  function load(cursor: string | null, previous: Idea[] = []) {
    setView({ kind: 'loading' });
    previousPage.current = previous;
    setRequest({ cursor });
  }
  return <section aria-labelledby="owned-ideas">
    <h2 id="owned-ideas">Your ideas</h2>
    {view.kind === 'loading' && <p role="status">Loading ideas…</p>}
    {view.kind === 'unavailable' && <><p role="status">Workspace data is unavailable.</p>
      <button type="button" onClick={() => load(null)}>Retry</button></>}
    {view.kind === 'ready' && (view.ideas.length === 0 ? <p role="status">You don’t have any ideas yet.</p> :
      <ul>{view.ideas.map(idea => <li key={idea.id}><strong>{idea.title}</strong>{idea.summary && <p>{idea.summary}</p>}</li>)}</ul>)}
    {view.kind === 'ready' && view.cursor && <button type="button" onClick={() => load(view.cursor, view.ideas)}>
      Load more ideas
    </button>}
  </section>;
}
