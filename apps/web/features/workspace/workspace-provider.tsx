// Client-side composition boundary. It starts unavailable and coordinates
// session changes, navigation, and scoped controllers supplied to the views.
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import type { MessageApi, SavedMessageApi, Scope, SessionSource, WorkspaceApi } from './contracts';
import { createReadController, type ReadController, type ReadResult } from './read-controller';
import { createCommandController, type CreateResult } from './create-controller';
import { createRecoveryStorage, type RecoveryStorage } from './submission-recovery-storage';
import { WorkspaceShell } from './workspace-shell';
import styles from './workspace.module.css';

type Workspace = {
  readOnly: boolean;
  api: WorkspaceApi;
  reads: ReadController;
  commands: ReturnType<typeof createCommandController>;
  scope: Scope;
  invalidateSession: () => void;
  messageApi: MessageApi | undefined;
  savedMessages?: SavedMessageApi | undefined;
  recovery: RecoveryStorage | undefined;
};
const WorkspaceContext = createContext<Workspace | null>(null);

export function WorkspaceProvider({ children, api, session, messageApi, recoveryTtl, savedMessages, recoverySessionId, accountAction, readOnly = false }: {
  children: ReactNode; accountAction?: ReactNode; readOnly?: boolean; api?: WorkspaceApi; session?: SessionSource;
  messageApi?: MessageApi; recoveryTtl?: number; savedMessages?: SavedMessageApi; recoverySessionId?: string;
}) {
  const pathname = usePathname();
  const reads = useMemo(createReadController, []);
  // Dependency injection lets a test supply the API and identity sources.
  // Normal composition supplies neither, so it cannot fetch protected data.
  const commands = useMemo(() => api ? createCommandController(api, reads.isCurrent) : null, [api, reads]);
  const recovery = useMemo(() => messageApi && recoveryTtl
    ? createRecoveryStorage(() => window.sessionStorage, recoveryTtl, Date.now, recoverySessionId) : undefined,
  [messageApi, recoveryTtl, recoverySessionId]);
  const [view, setView] = useState<{ pathname: string; scope: Scope | null } | null>(null);
  const [sessionRevision, setSessionRevision] = useState(0);

  const invalidateSession = useCallback(() => {
    reads.enter(null, true);
    commands?.clear();
    savedMessages?.clear();
    recovery?.clear();
    setView(null);
  }, [reads, commands, recovery, savedMessages]);

  // Client Components can react to browser events. Layout effects run before
  // paint, so old route content is gated before a newly selected route paints.
  useLayoutEffect(() => {
    if (!session || !commands) return;
    function onSessionChange() {
      reads.enter(null, true);
      commands?.clear();
      savedMessages?.clear();
      recovery?.clear();
      setView(null);
      setSessionRevision(revision => revision + 1);
    }
    const unsubscribe = session.subscribe(() => flushSync(onSessionChange));
    return () => {
      unsubscribe();
      reads.enter(null, true);
      commands.clear();
      savedMessages?.clear();
    };
  }, [session, commands, reads, recovery, savedMessages]);

  useLayoutEffect(() => {
    if (!session || !commands) return;
    const source = session;
    let revision = 0;
    let active = true;
    async function reopen() {
      const attempt = ++revision;
      reads.enter(source.getSnapshot()?.localAccountId ?? null);
      setView(null);
      try { await source.revalidate(); } catch { return; }
      if (!active || attempt !== revision) return;
      const account = source.getSnapshot()?.localAccountId ?? null;
      if (!account) recovery?.clear();
      else recovery?.sweep(account);
      const scope = reads.enter(account);
      setView({ pathname, scope });
    }
    function hide() {
      revision++;
      reads.enter(source.getSnapshot()?.localAccountId ?? null);
      flushSync(() => setView(null));
    }
    function restore() {
      // Re-entry means reopening a route via refresh or browser history.
      // Revalidate before allowing browser-restored content to paint.
      hide();
      void reopen();
    }
    void reopen();
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', restore);
    window.addEventListener('popstate', restore);
    window.addEventListener('focus', restore);
    return () => {
      active = false;
      reads.enter(source.getSnapshot()?.localAccountId ?? null);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', restore);
      window.removeEventListener('popstate', restore);
      window.removeEventListener('focus', restore);
    };
  }, [session, commands, reads, recovery, pathname, sessionRevision]);

  const scope = view?.pathname === pathname ? view.scope : null;
  const value = scope && reads.isCurrent(scope) && api && commands
    ? { readOnly, scope, api, reads, commands, invalidateSession, messageApi, recovery, savedMessages } : null;
  return <WorkspaceShell accountAction={accountAction}>
    {value ? <WorkspaceContext.Provider key={scope?.routeGeneration} value={value}>{children}</WorkspaceContext.Provider>
      : <><h1>Workspace unavailable</h1><p role="status">A workspace session is required.</p></>}
  </WorkspaceShell>;
}

export function useWorkspace() {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error('Workspace views require an active provider scope.');
  return workspace;
}

export function useWorkspaceRead<T>(load: (workspace: Workspace) => Promise<ReadResult<T>>) {
  const { readOnly, api, reads, commands, scope, invalidateSession, messageApi, recovery, savedMessages } = useWorkspace();
  const [state, setState] = useState<{ load: typeof load; result: ReadResult<T> }>();
  useEffect(() => {
    // React renders the current state. Effects start asynchronous work after
    // a render and clean up when that input changes or the view unmounts.
    let active = true;
    void load({ readOnly, api, reads, commands, scope, invalidateSession, messageApi, recovery, savedMessages }).then(result => {
      if (!active || !reads.isCurrent(scope)) return;
      if (result.kind === 'signed-out' || result.kind === 'blocked') {
        invalidateSession();
        return;
      }
      setState({ load, result });
    });
    return () => { active = false; };
  }, [readOnly, api, reads, commands, scope, load, invalidateSession, messageApi, recovery, savedMessages]);
  return state?.load === load ? state.result : { kind: 'loading' as const };
}

export function readNotice(kind: 'loading' | 'missing' | 'blocked' | 'signed-out' | 'error' | 'stale', retry: () => void) {
  if (kind === 'loading' || kind === 'stale') return <p className={styles['feedback']} role="status">Loading workspace...</p>;
  if (kind === 'missing') return <><p role="status">This workspace item is unavailable.</p><Link href="/app" prefetch={false}>Back to my ideas</Link></>;
  return <><p className={styles['feedback']} role="alert">The workspace could not be loaded.</p><button onClick={retry}>Retry read</button></>;
}

export function createNotice(kind: CreateResult<unknown>['kind'] | undefined) {
  if (kind === 'pending') return <p role="status">Creating...</p>;
  if (kind === 'rejected') return <p role="alert">The create request was rejected.</p>;
  return null;
}
