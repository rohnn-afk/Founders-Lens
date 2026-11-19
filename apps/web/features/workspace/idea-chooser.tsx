// Idea chooser view. It renders one authorized page and submits explicit
// creation intents through the workspace controllers.
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useState, type FormEvent } from 'react';
import type { Idea } from './contracts';
import type { CreateResult } from './create-controller';
import { createNotice, readNotice, useWorkspace, useWorkspaceRead } from './workspace-provider';
import styles from './workspace.module.css';

export function IdeaChooser() {
  const workspace = useWorkspace();
  const router = useRouter();
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [revision, setRevision] = useState(0);
  const [title, setTitle] = useState('');
  const [creation, setCreation] = useState<CreateResult<Idea>['kind']>();
  const cursor = cursors.at(-1) ?? null;
  const load = useCallback(({ api, scope, reads }: typeof workspace) => {
    return reads.read(scope, ['ideas', cursor], signal => api.ideas(cursor, signal), revision === 0);
  }, [cursor, revision]);
  const result = useWorkspaceRead(load);
  const retry = () => setRevision(value => value + 1);

  async function create(retryIntent: boolean) {
    const { commands, scope, reads, invalidateSession } = workspace;
    setCreation('pending');
    const outcome = await commands.submitIdea(scope, retryIntent ? undefined : { title });
    if (!reads.isCurrent(scope)) return;
    if (outcome.kind === 'signed-out' || outcome.kind === 'blocked') return invalidateSession();
    setCreation(outcome.kind);
    if (outcome.kind === 'created') router.push('/app/ideas/' + encodeURIComponent(outcome.data.id) + '/think');
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void create(false);
  }

  return <>
    <h1>My ideas</h1>
    {result.kind !== 'ready' ? readNotice(result.kind, retry) : <>
      {result.data.items.length === 0 && <p role="status">{cursor ? 'No ideas on this page.' : 'Your first idea starts with a conversation.'}</p>}
      {result.data.items.length > 0 && <ul className={styles['list']}>
        {result.data.items.map(idea => <li key={idea.id}>
          {idea.status === 'ACTIVE' || idea.status === 'ARCHIVED'
            ? <Link prefetch={false} href={'/app/ideas/' + encodeURIComponent(idea.id) + '/think'}>{idea.title}</Link>
            : <span>Idea unavailable</span>}
          {idea.status === 'ARCHIVED' && <p>Archived (read only)</p>}
        </li>)}
      </ul>}
      <nav aria-label="Idea pages" className={styles['actions']}>
        {cursors.length > 1 && <button onClick={() => setCursors(cursors.slice(0, -1))}>Previous page</button>}
        {result.data.page.hasMore && result.data.page.nextCursor && <button onClick={() => setCursors([...cursors, result.data.page.nextCursor])}>Next page</button>}
      </nav>
      <h2>Create an idea</h2>
      {createNotice(creation)}
      {creation === 'uncertain' || workspace.commands.ideaUncertain()
        ? <><p role="status">Creation could not be confirmed. Retrying uses the original idea and key.</p>
          <button disabled={creation === 'pending'} onClick={() => void create(true)}>Retry original idea</button></>
        : <form onSubmit={submit} className={styles['form']}>
          <label htmlFor="idea-title">Idea title</label>
          <input id="idea-title" required value={title} onChange={event => setTitle(event.target.value)} />
          <button disabled={creation === 'pending'}>Create idea</button>
        </form>}
    </>}
  </>;
}
