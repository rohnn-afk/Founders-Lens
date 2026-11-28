'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { appearanceKey, appearances, type Appearance } from './appearance';
import styles from './workspace.module.css';

function AppearanceControl() {
  const [appearance, setAppearance] = useState<Appearance>('system');

  useLayoutEffect(() => {
    // Match the selector to the preference already applied by the document.
    const applied = document.documentElement.dataset['workspaceAppearance'];
    setAppearance(appearances.find(option => option === applied) ?? 'system');
  }, []);

  function applyAppearance(value: Appearance) {
    document.documentElement.dataset['workspaceAppearance'] = value;
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
    <select value={appearance} onChange={event => choose(event.target.value)}>
      <option value="system">System</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  </label>;
}

/** Shared landmarks and appearance controls for workspace routes. */
export function WorkspaceShell({ children, accountAction }: { children: ReactNode; accountAction?: ReactNode }) {
  const pathname = usePathname();
  const mobileNav = useRef<HTMLDetailsElement>(null);
  const ideaLink = <Link href="/app" prefetch={false} onClick={() => {
    if (mobileNav.current?.open) {
      mobileNav.current.open = false;
      if (pathname === '/app') document.getElementById('workspace-main')?.focus({ preventScroll: true });
    }
  }}
    aria-current={pathname === '/app' ? 'page' : pathname.startsWith('/app/ideas/') ? 'location' : undefined}>
    My ideas
  </Link>;
  useEffect(() => {
    // Keep keyboard and assistive-technology users oriented after a route
    // change. Background revalidation does not move focus.
    if (mobileNav.current) mobileNav.current.open = false;
    document.getElementById('workspace-main')?.focus({ preventScroll: true });
  }, [pathname]);

  return (
    <div className={styles['shell']} data-workspace-shell="">
      <a className={styles['skip']} href="#workspace-main">Skip to content</a>
      <header className={styles['header']}>
        <details ref={mobileNav} className={styles['mobileNav']}>
          <summary>Menu</summary>
          <nav aria-label="Workspace" className={styles['menu']}>{ideaLink}</nav>
        </details>
        <Link className={styles['brand']} href="/" prefetch={false}>Founder&apos;s Lens</Link>
        {accountAction ? <details className={styles['account']} onKeyDown={event => {
          if (event.key === 'Escape' && event.currentTarget.open) {
            event.currentTarget.open = false;
            event.currentTarget.querySelector('summary')?.focus();
          }
        }}>
          <summary>Account</summary>
          <div className={styles['menu']}><AppearanceControl />{accountAction}</div>
        </details> : <div className={styles['account']}><AppearanceControl /></div>}
      </header>
      <div className={styles['body']}>
        <nav aria-label="Workspace" className={styles['sidebar']}>{ideaLink}</nav>
        <main id="workspace-main" tabIndex={-1} className={styles['main']}>
          {children}
        </main>
      </div>
    </div>
  );
}
