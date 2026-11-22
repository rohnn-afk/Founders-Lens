// Selected conversation view. It displays private data only after the controller
// verifies both the route's idea and the conversation's parent relationship.
'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MessageApi, SavedMessageApi } from './contracts';
import { createGenerationController, isTerminal, type GenerationView } from './generation-controller';
import { createMessageController } from './message-controller';
import { readConversation } from './read-controller';
import type { RecoveryStorage } from './submission-recovery-storage';
import { readNotice, useWorkspace, useWorkspaceRead } from './workspace-provider';
import styles from './workspace.module.css';

export function ConversationView({ ideaId, conversationId }: { ideaId: string; conversationId: string }) {
  const [revision, setRevision] = useState(0);
  const { savedMessages } = useWorkspace();
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
  useEffect(() => {
    if (result.kind === 'missing') savedMessages?.clear(conversationId);
  }, [result.kind, savedMessages, conversationId]);
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
  const { messageApi, recovery, savedMessages } = useWorkspace();
  if (savedMessages) return <SavedTranscript api={savedMessages} conversationId={conversationId} archived={archived} />;
  if (!messageApi || !recovery) return null;
  return <MessagePanel api={messageApi} recovery={recovery} ideaId={ideaId} conversationId={conversationId} archived={archived} />;
}

/** Show committed turns and retain only the in-memory intent for an uncertain save. */
function SavedTranscript({ api, conversationId, archived }: { api: SavedMessageApi; conversationId: string; archived: boolean }) {
  const { scope, reads, invalidateSession } = useWorkspace();
  const [draft, setDraft] = useState(() => api.pending(conversationId) ?? '');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [revision, refresh] = useState(0);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const writerLifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const active = new AbortController();
    writerLifetime.current = active;
    return () => active.abort();
  }, []);
  const cursor = cursors.at(-1) ?? null;
  const load = useCallback((workspace: ReturnType<typeof useWorkspace>) => {
    void revision;
    return workspace.reads.read(workspace.scope, ['saved-messages', conversationId, cursor],
      signal => api.history(conversationId, cursor, signal));
  }, [api, conversationId, cursor, revision]);
  const history = useWorkspaceRead(load);
  const pending = api.pending(conversationId) !== undefined;
  useEffect(() => {
    if (history.kind !== 'missing') return;
    invalidateSession();
  }, [invalidateSession, history.kind]);

  async function save(retry: boolean) {
    const lifetime = writerLifetime.current;
    if (!lifetime || lifetime.signal.aborted || saving || archived || history.kind !== 'ready') return;
    if (!retry && (!draft.trim() || Array.from(draft).length > 10_000)) {
      setNotice('Enter a message up to 10,000 characters.');
      return;
    }
    setSaving(true);
    setNotice('');
    const signal = AbortSignal.any([scope.signal, lifetime.signal]);
    const reply = await api.save(conversationId, retry ? undefined : draft, signal);
    if (signal.aborted || !reads.isCurrent(scope)) return;
    setSaving(false);
    if (reply.status === 401 || reply.status === 403 || reply.status === 404) { invalidateSession(); return; }
    if (reply.status === 201) {
      setDraft('');
      setNotice('Message saved.');
      setCursors([null]);
      refresh(value => value + 1);
    } else if (reply.status === 409) setNotice('This save conflicts with an earlier request. Refresh the transcript before sending again.');
    else if (!api.pending(conversationId)) setNotice('The message could not be saved. Check the message and try again.');
  }

  return <section aria-label="Saved messages">
    {history.kind === 'ready' ? <>
      {history.data.items.length === 0 ? <p role="status">No saved messages yet.</p> : <ol className={styles['list']}>
        {history.data.items.map(item => <li key={item.id}><strong>{item.role === 'USER' ? 'You' : 'Assistant'}</strong>
          <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.content}</p></li>)}
      </ol>}
      <nav aria-label="Transcript pages">
        {cursors.length > 1 && <button onClick={() => setCursors(cursors.slice(0, -1))}>Previous messages</button>}
        {history.data.page.nextCursor && <button onClick={() => setCursors([...cursors, history.data.page.nextCursor])}>Next messages</button>}
      </nav>
      {!archived && <form className={styles['form']} onSubmit={event => { event.preventDefault(); void save(false); }}>
        <label htmlFor="save-message">Message</label>
        <textarea id="save-message" value={draft} required disabled={saving || pending} onChange={event => setDraft(event.target.value)} />
        {pending ? <button type="button" disabled={saving} onClick={() => void save(true)}>Retry original message</button>
          : <button type="submit" disabled={saving}>Save message</button>}
      </form>}
    </> : readNotice(history.kind, () => refresh(value => value + 1))}
    {saving ? <p role="status">Saving message…</p> : pending && history.kind === 'ready' && <p role="status">Save could not be confirmed.</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
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
