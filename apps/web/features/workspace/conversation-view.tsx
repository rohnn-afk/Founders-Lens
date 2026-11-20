// Selected conversation view. It displays private data only after the controller
// verifies both the route's idea and the conversation's parent relationship.
'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MessageApi } from './contracts';
import { createMessageController } from './message-controller';
import { readConversation } from './read-controller';
import type { RecoveryStorage } from './submission-recovery-storage';
import { readNotice, useWorkspace, useWorkspaceRead } from './workspace-provider';
import styles from './workspace.module.css';

export function ConversationView({ ideaId, conversationId }: { ideaId: string; conversationId: string }) {
  const [revision, setRevision] = useState(0);
  const load = useCallback(({ reads, api, scope, recovery }: ReturnType<typeof useWorkspace>) => {
    void revision;
    return readConversation(reads, { ...api, async idea(id, signal) {
      const reply = await api.idea(id, signal);
      if (reads.isCurrent(scope) && reply.status === 200 && reply.data.id === ideaId &&
        ['DELETION_REQUESTED', 'PURGING', 'DELETED'].includes(reply.data.status)) recovery?.removeIdea(scope.account, ideaId);
      return reply;
    } }, scope, ideaId, conversationId);
  }, [conversationId, ideaId, revision]);
  const result = useWorkspaceRead(load);
  if (result.kind !== 'ready') return <><h1>Conversation</h1>{readNotice(result.kind, () => setRevision(value => value + 1))}</>;
  const { idea, conversation } = result.data;
  const archived = idea.status === 'ARCHIVED' || conversation.status === 'ARCHIVED';
  return <>
    <h1>{conversation.title || 'Untitled conversation'}</h1>
    <p>{idea.title}</p>
    {archived && <p role="status">Archived (read only)</p>}
    <ConversationMessages ideaId={ideaId} conversationId={conversationId} archived={archived} />
    <Link prefetch={false} href={'/app/ideas/' + encodeURIComponent(ideaId) + '/think'}>Back to Think</Link>
  </>;
}

function ConversationMessages({ ideaId, conversationId, archived }: {
  ideaId: string; conversationId: string; archived: boolean;
}) {
  const { messageApi, recovery } = useWorkspace();
  if (!messageApi || !recovery) return null;
  return <MessagePanel api={messageApi} recovery={recovery} ideaId={ideaId} conversationId={conversationId} archived={archived} />;
}

function MessagePanel({ api, recovery, ideaId, conversationId, archived }: {
  api: MessageApi; recovery: RecoveryStorage; ideaId: string; conversationId: string; archived: boolean;
}) {
  const { scope, reads, invalidateSession } = useWorkspace();
  const controller = useMemo(() => createMessageController(api, recovery, scope, ideaId, conversationId,
    reads.isCurrent, invalidateSession), [api, recovery, scope, ideaId, conversationId, reads, invalidateSession]);
  const [state, setState] = useState<ReturnType<typeof controller.state>>();
  const [draft, setDraft] = useState('');
  const [revision, refresh] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  useEffect(() => { setState(controller.restore()); }, [controller]);
  const load = useCallback((workspace: ReturnType<typeof useWorkspace>) => {
    void revision;
    return workspace.reads.read(workspace.scope, ['messages', ideaId, conversationId, cursor], async signal => {
      const reply = await api.history(conversationId, cursor, signal);
      if (reply.status === 200 && reply.data.items.some(message => message.conversationId !== conversationId)) {
        return { status: 404 };
      }
      return reply;
    });
  }, [api, conversationId, cursor, ideaId, revision]);
  const history = useWorkspaceRead(load);

  async function act(action: 'send' | 'check') {
    const work = action === 'send' ? controller.send(draft) : controller.check();
    setState(controller.state());
    const result = await work;
    if (!result || !reads.isCurrent(scope)) return;
    setState(result);
    if (action === 'send' && (result === 'accepted' || result === 'unknown')) setDraft('');
    if (action === 'check' || result === 'accepted') setCursor(null);
    refresh(value => value + 1);
  }

  const canCheck = state === 'unknown' || state === 'checking';
  return <section aria-label="Messages" className={styles['messages']}>
    <h2>Message history</h2>
    {history.kind === 'ready' ? <>
      {history.data.items.length === 0 ? <p>No saved messages.</p> :
        <ol>{history.data.items.map(message => <li key={message.id}>
          <strong>{message.role === 'USER' ? 'You' : 'Assistant'}</strong>
          <p>{message.content}</p>
        </li>)}</ol>}
      {cursor && <button type="button" onClick={() => setCursor(null)}>First page</button>}
      {history.data.page.nextCursor && <button type="button" onClick={() => setCursor(history.data.page.nextCursor)}>Next page</button>}
    </> : readNotice(history.kind, () => refresh(value => value + 1))}
    <div role="status">
      {state === 'sending' && 'Sending…'}
      {state === 'accepted' && 'Message accepted.'}
      {state === 'unknown' && 'Acceptance is unknown. Check again or review saved messages.'}
      {state === 'checking' && 'Checking whether it was saved…'}
      {state === 'history-only' && 'Acceptance cannot be confirmed from this tab. Review saved messages.'}
      {state === 'rejected' && 'The message was rejected.'}
    </div>
    {canCheck && <button type="button" disabled={state === 'checking'} onClick={() => void act('check')}>Check Again</button>}
    {!archived && !canCheck && state !== 'history-only' && <form onSubmit={event => { event.preventDefault(); void act('send'); }}>
      <label htmlFor="workspace-message">Message</label>
      <textarea id="workspace-message" value={draft} disabled={state === 'sending'}
        onChange={event => setDraft(event.target.value)} required />
      <button type="submit" disabled={!state || state === 'sending' || !draft.length}>Send message</button>
    </form>}
  </section>;
}
