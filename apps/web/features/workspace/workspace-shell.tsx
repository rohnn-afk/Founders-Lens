'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import styles from './workspace.module.css';

const appearanceKey = 'founders-lens.appearance';
const appearances = ['system', 'light', 'dark'] as const;
type Appearance = typeof appearances[number];

// A parser-time script applies a saved preference before the workspace content
// paints. It reads a single display setting and changes only the workspace shell.
const initializeAppearance = `(() => {
  try {
    const value = localStorage.getItem(${JSON.stringify(appearanceKey)});
    if (${JSON.stringify(appearances)}.includes(value)) {
      document.currentScript.parentElement.dataset.workspaceAppearance = value;
    }
  } catch {
    // CSS already follows the system when storage is denied.
  }
})();`;

function AppearanceControl() {
  const select = useRef<HTMLSelectElement>(null);
  const [appearance, setAppearance] = useState<Appearance>('system');

  useLayoutEffect(() => {
    // The first React render matches the server. Before paint, sync the
    // selector and cover client navigation, where the inline script may not run.
    try {
      const stored = window.localStorage.getItem(appearanceKey);
      const saved = appearances.find(option => option === stored);
      if (saved) applyAppearance(saved);
    } catch {
      // Appearance still works for this visit when browser storage is blocked.
    }
  }, []);

  function applyAppearance(value: Appearance) {
    const shell = select.current?.closest<HTMLElement>('[data-workspace-appearance]');
    if (shell) shell.dataset['workspaceAppearance'] = value;
    setAppearance(value);
  }

  function choose(value: string) {
    const choice = appearances.find(option => option === value);
    if (!choice) return;
    applyAppearance(choice);
    try {
      window.localStorage.setItem(appearanceKey, choice);
    } catch {
      // A display choice can be applied without writing any browser storage.
    }
  }

  return <label className={styles['appearance']}>Appearance
    <select ref={select} value={appearance} onChange={event => choose(event.target.value)}>
      <option value="system">System</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  </label>;
}

/** Shared landmarks and appearance controls for workspace routes. */
export function WorkspaceShell({ children, accountAction }: { children: ReactNode; accountAction?: ReactNode }) {
  const pathname = usePathname();
  useEffect(() => {
    // Keep keyboard and assistive-technology users oriented after a route
    // change. Background revalidation does not move focus.
    document.getElementById('workspace-main')?.focus({ preventScroll: true });
  }, [pathname]);

  return (
    // Only this attribute may differ when the parser-time script runs before
    // hydration, when React attaches behavior to the server-rendered markup.
    <div className={styles['shell']} data-workspace-appearance="system" suppressHydrationWarning>
      <script dangerouslySetInnerHTML={{ __html: initializeAppearance }} />
      <a className={styles['skip']} href="#workspace-main">Skip to content</a>
      <header className={styles['header']}>
        <nav aria-label="Workspace"><Link className={styles['brand']} href="/" prefetch={false}>Founder&apos;s Lens</Link>
          <Link href="/app" prefetch={false} aria-current={pathname === '/app' ? 'page' : undefined}>My ideas</Link>
        </nav>
        <div className={styles['actions']}><AppearanceControl />{accountAction}</div>
      </header>
      <main id="workspace-main" tabIndex={-1} className={styles['main']}>
        {children}
      </main>
    </div>
  );
}
