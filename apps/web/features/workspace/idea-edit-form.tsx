'use client';

import { useEffect, useRef, useState } from 'react';
import type { Idea, IdeaEdit, Reply } from './contracts';
import styles from './workspace.module.css';

export function IdeaEditForm({ idea, edit, saved, reload, close, denied }: {
  idea: Idea;
  edit(id: string, version: number, body: IdeaEdit, signal: AbortSignal): Promise<Reply<Idea>>;
  saved(idea: Idea): void;
  reload(): void;
  close(): void;
  denied(status: 401 | 403): void;
}) {
  const [title, setTitle] = useState(idea.title);
  const [summary, setSummary] = useState(idea.summary ?? '');
  const [state, setState] = useState<'idle' | 'pending' | 'invalid' | 'stale' | 'unknown'>('idle');
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);

  async function save() {
    if (active.current || state === 'stale' || state === 'unknown') return;
    if (!title.trim() || Array.from(title).length > 200 || Array.from(summary).length > 5000) {
      setState('invalid');
      return;
    }
    const patch: IdeaEdit = {};
    if (title !== idea.title) patch.title = title;
    if (summary !== (idea.summary ?? '')) patch.summary = summary || null;
    if (Object.keys(patch).length === 0) return;
    const controller = new AbortController();
    active.current = controller;
    setState('pending');
    try {
      const reply = await edit(idea.id, idea.version, patch, controller.signal);
      if (controller.signal.aborted) return;
      if (reply.status === 200) saved(reply.data);
      else if (reply.status === 401 || reply.status === 403) denied(reply.status);
      else if (reply.status === 400) setState('invalid');
      else if (reply.status === 412) setState('stale');
      else setState('unknown');
    } catch {
      if (!controller.signal.aborted) setState('unknown');
    } finally { active.current = null; }
  }

  const needsReload = state === 'stale' || state === 'unknown';
  return <form onSubmit={event => { event.preventDefault(); void save(); }}>
    <fieldset className={styles['form']} disabled={state === 'pending' || needsReload}>
      <legend>Edit idea</legend>
      <label htmlFor="edit-idea-title">Title</label>
      <input id="edit-idea-title" required value={title} onChange={event => setTitle(event.target.value)} />
      <label htmlFor="edit-idea-summary">Summary (optional)</label>
      <textarea id="edit-idea-summary" value={summary} onChange={event => setSummary(event.target.value)} />
      <button className={styles['primary']} type="submit"
        disabled={title === idea.title && summary === (idea.summary ?? '')}>Save changes</button>
    </fieldset>
    {state === 'pending' && <p role="status">Saving changes…</p>}
    {state === 'invalid' && <p role="alert">Enter a nonblank title up to 200 characters and a summary up to 5,000 characters.</p>}
    {needsReload && <>
      <p role="alert">{state === 'stale' ? 'This idea changed since you opened it.' : 'The update could not be confirmed.'}</p>
      <button type="button" onClick={reload}>Reload ideas and discard draft</button>
    </>}
    <button type="button" onClick={close} disabled={state === 'pending'}>Cancel edit</button>
  </form>;
}
