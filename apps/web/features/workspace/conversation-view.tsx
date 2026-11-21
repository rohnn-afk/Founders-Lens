// Selected conversation view. It displays private data only after the controller
// verifies both the route's idea and the conversation's parent relationship.
'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MessageApi } from './contracts';
import { createGenerationController, isTerminal, type GenerationView } from './generation-controller';
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
  const [generation, setGeneration] = useState<GenerationView>({ observation: 'idle' });
  const observer = useRef<ReturnType<typeof createGenerationController> | null>(null);
  const reloadHistory = useCallback(() => { setCursor(null); refresh(value => value + 1); }, []);
  useEffect(() => { setState(controller.restore()); }, [controller]);
  useEffect(() => {
    if (!api.generation) return;
    const next = createGenerationController(api.generation, scope, conversationId, reads.isCurrent, value => {
      setGeneration(value);
      if (value.observation === 'blocked') setDraft('');
    }, reloadHistory, invalidateSession);
    observer.current = next;
    return () => { observer.current = null; next.stop(); };
  }, [api.generation, conversationId, invalidateSession, reads, reloadHistory, scope]);
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
  const historyUnavailable = history.kind === 'missing';
  useEffect(() => {
    if (!historyUnavailable) return;
    observer.current?.stop();
    setGeneration({ observation: 'idle' });
    setDraft('');
  }, [historyUnavailable]);

  async function act(action: 'send' | 'check') {
    const work = action === 'send' ? controller.send(draft) : controller.check();
    setState(controller.state());
    const result = await work;
    if (!result || !reads.isCurrent(scope)) return;
    setState(result);
    if (action === 'send' && (result === 'accepted' || result === 'unknown')) setDraft('');
    if (action === 'check' || result === 'accepted') setCursor(null);
    const accepted = result === 'accepted' ? controller.acceptance() : undefined;
    if (accepted) observer.current?.observe(accepted.generationId);
    refresh(value => value + 1);
  }

  const value = generation.value;
  const active = value && !isTerminal(value.status);
  const lastUser = history.kind === 'ready' && !history.data.page.hasMore
    ? history.data.items.findLast(item => item.role === 'USER') : undefined;
  const sendingCommand = generation.command === 'sending';
  const unknownCommand = generation.command === 'unknown';
  const canCheck = state === 'unknown' || state === 'checking';
  if (historyUnavailable) return <section aria-label="Messages">{readNotice('missing', reloadHistory)}</section>;
  if (generation.observation === 'blocked') return <section aria-label="Messages">
    <p role="status">The conversation is unavailable. Check status to revalidate access.</p>
    {unknownCommand && !archived
      ? <button type="button" onClick={() => void observer.current?.retry()}>Retry same command</button>
      : <button type="button" onClick={() => observer.current?.observe()}>Check status</button>}
  </section>;
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
    {api.generation && <div className={styles['generationActions']}>
      <div role="status">
        {value ? {
          PENDING: 'Generation pending.', RUNNING: 'Generating response…',
          CANCEL_REQUESTED: 'Cancellation requested.', COMPLETED: 'Generation completed.',
          FAILED: 'Generation failed.', CANCELLED: 'Generation cancelled.'
        }[value.status] : generation.observation === 'observing' ? 'Checking generation status…' : ''}
        {generation.observation === 'paused' && ' Status observation paused.'}
        {unknownCommand && ' Command outcome is unknown.'}
        {generation.command === 'rejected' && ' The command was rejected.'}
      </div>
      {generation.observation === 'paused' && <button type="button" disabled={sendingCommand}
        onClick={() => observer.current?.observe()}>Check status</button>}
      {!archived && !canCheck && state !== 'sending' && history.kind === 'ready' && <>
        {unknownCommand ? <button type="button" onClick={() => void observer.current?.retry()}>Retry same command</button>
          : active && value.status !== 'CANCEL_REQUESTED' ? <button type="button" disabled={sendingCommand}
            onClick={() => void observer.current?.cancel()}>Stop</button>
            : !active && lastUser && generation.observation !== 'observing' &&
              <button type="button" disabled={sendingCommand}
                onClick={() => void observer.current?.regenerate(lastUser.id)}>Regenerate</button>}
      </>}
    </div>}
    {canCheck && <button type="button" disabled={state === 'checking'} onClick={() => void act('check')}>Check Again</button>}
    {!archived && !canCheck && state !== 'history-only' && <form onSubmit={event => { event.preventDefault(); void act('send'); }}>
      <label htmlFor="workspace-message">Message</label>
      <textarea id="workspace-message" value={draft} disabled={state === 'sending' || sendingCommand || unknownCommand}
        onChange={event => setDraft(event.target.value)} required />
      <button type="submit" disabled={!state || state === 'sending' || sendingCommand || unknownCommand || !draft.length}>Send message</button>
    </form>}
  </section>;
}
