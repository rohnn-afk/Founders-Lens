// Think view. It presents one idea's conversation chooser and reconciles
// uncertain creation through authorized reads rather than another POST.
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useState, type FormEvent } from 'react';
import type { Conversation } from './contracts';
import type { CreateResult } from './create-controller';
import { readThink } from './read-controller';
import { createNotice, readNotice, useWorkspace, useWorkspaceRead } from './workspace-provider';
import styles from './workspace.module.css';

export function ThinkView({ ideaId }: { ideaId: string }) {
  const workspace = useWorkspace();
  const router = useRouter();
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [revision, setRevision] = useState(0);
  const [title, setTitle] = useState('');
  const [creation, setCreation] = useState<CreateResult<Conversation>['kind']>();
  const cursor = cursors.at(-1) ?? null;
  const load = useCallback(({ reads, api, scope }: typeof workspace) => {
    void revision;
    return readThink(reads, api, scope, ideaId, cursor);
  }, [ideaId, cursor, revision]);
  const result = useWorkspaceRead(load);
  const retry = () => setRevision(value => value + 1);
  const base = '/app/ideas/' + encodeURIComponent(ideaId);
  if (result.kind !== 'ready') return <><h1>Think</h1>{readNotice(result.kind, retry)}</>;
  const { idea, conversations } = result.data;
  const commandState = creation ?? workspace.commands.conversationState(ideaId);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const { scope, commands, reads, invalidateSession } = workspace;
    setCreation('pending');
    const outcome = await commands.submitConversation(scope, ideaId, title ? { title } : {});
    if (!reads.isCurrent(scope)) return;
    if (outcome.kind === 'signed-out' || outcome.kind === 'blocked') return invalidateSession(outcome.kind);
    setCreation(outcome.kind);
    if (outcome.kind === 'uncertain' && workspace.savedMessages) { setCursors([null]); retry(); }
    if (outcome.kind === 'created' && outcome.data.ideaId === ideaId) {
      router.push(base + '/conversations/' + encodeURIComponent(outcome.data.id));
    }
  }

  return <>
    <header className={styles['pageHeader']}>
      <Link href="/app" prefetch={false}>All ideas</Link>
      <h1>{idea.title}</h1>
      {idea.summary && <p>{idea.summary}</p>}
    </header>
    <div className={styles['overview']}>
      <section aria-labelledby="conversation-list">
        <h2 id="conversation-list">Conversations</h2>
        {idea.status === 'ARCHIVED' && <p role="status">Archived (read only)</p>}
        {conversations.items.length === 0 ? <div className={styles['empty']}><p>{cursor ? 'No conversations on this page.' : 'No conversations yet.'}</p>
          {!cursor && !workspace.readOnly && idea.status === 'ACTIVE' && <p>Start with a question about this idea.</p>}</div> :
          <ul className={styles['list']}>
            {conversations.items.map(item => <li key={item.id}>
              <Link prefetch={false} href={base + '/conversations/' + encodeURIComponent(item.id)}>{item.title || 'Untitled conversation'}</Link>
              {item.status === 'ARCHIVED' && <p>Archived (read only)</p>}
            </li>)}
          </ul>}
        <nav aria-label="Conversation pages" className={styles['actions']}>
          {cursors.length > 1 && <button onClick={() => setCursors(cursors.slice(0, -1))}>Previous page</button>}
          {conversations.page.hasMore && conversations.page.nextCursor &&
            <button onClick={() => setCursors([...cursors, conversations.page.nextCursor])}>Next page</button>}
        </nav>
      </section>
      {!workspace.readOnly && idea.status === 'ACTIVE' && <section aria-labelledby="new-conversation" className={styles['panel']}>
        <h2 id="new-conversation">New conversation</h2>
        {createNotice(commandState)}
        {commandState === 'uncertain'
          ? <><p role="status">Creation could not be confirmed. Checking the list can show saved conversations, but an absent result does not prove failure.</p>
            <button onClick={() => { setCursors([null]); retry(); }}>Check conversations</button></>
          : <form onSubmit={create} className={styles['form']}>
            <label htmlFor="conversation-title">Conversation title (optional)</label>
            <input id="conversation-title" value={title} onChange={event => setTitle(event.target.value)} />
            <button className={styles['primary']} disabled={commandState === 'pending'}>{workspace.savedMessages ? 'Start conversation' : 'Create conversation'}</button>
          </form>}
      </section>}
    </div>
  </>;
}
