'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { AssistantText } from './assistant-text';
import type { Message, Page } from './contracts';
import styles from './workspace.module.css';

const nearEnd = (element: HTMLElement) => element.scrollHeight - element.clientHeight - element.scrollTop <= 48;

function restorePosition(key: string) {
  try {
    const value = window.sessionStorage.getItem(key);
    if (value === null) return null;
    const offset = Number(value);
    return Number.isFinite(offset) && offset >= 0 ? offset : null;
  } catch {
    return null;
  }
}

export function Transcript({ conversationId, page, pageIndex, archived }: {
  conversationId: string; page: Page<Message> | undefined; pageIndex: number; archived: boolean;
}) {
  const element = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<number, { top: number; follow: boolean }>());
  const [canJump, setCanJump] = useState(false);
  // Only a pixel offset for the first page is stored. Text, cursors and identity stay out of storage.
  const key = 'founders-lens.transcript-scroll:' + conversationId;

  function record(scroller: HTMLDivElement) {
    const follow = nearEnd(scroller);
    positions.current.set(pageIndex, { top: scroller.scrollTop, follow });
    setCanJump(!follow);
    if (pageIndex !== 0) return;
    try {
      if (follow && page && !page.page.hasMore) window.sessionStorage.removeItem(key);
      else window.sessionStorage.setItem(key, String(scroller.scrollTop));
    } catch {
      // Scrolling still works when browser storage is unavailable.
    }
  }

  useLayoutEffect(() => {
    const scroller = element.current;
    if (!scroller || !page) return;
    const previous = positions.current.get(pageIndex);
    const saved = !previous && pageIndex === 0 ? restorePosition(key) : null;
    if (previous) {
      scroller.scrollTop = previous.follow && !page.page.hasMore ? scroller.scrollHeight : previous.top;
    } else {
      scroller.scrollTop = saved ?? (!page.page.hasMore ? scroller.scrollHeight : 0);
    }
    record(scroller);
  }, [key, page, pageIndex]);

  return <>
    <div ref={element} className={styles['transcriptViewport']} role="region" aria-label="Conversation transcript"
      tabIndex={0} aria-busy={!page} onScroll={event => { if (page) record(event.currentTarget); }}>
      {page && (page.items.length ? <ol className={styles['transcript']}>
        {page.items.map(item => <li key={item.id} className={styles['turn']} data-speaker={item.role === 'USER' ? 'founder' : 'assistant'}>
          <div className={styles['speaker']}>{item.role === 'USER' ? 'You' : 'Assistant'}</div>
          {item.role === 'USER' ? <p className={styles['founderText']}>{item.content}</p> :
            <div className={styles['assistantText']}><AssistantText content={item.content} /></div>}
        </li>)}
      </ol> : <div className={styles['empty']}>
        <p>No saved messages.</p>
        {!archived && <p>Start with a decision you are weighing or an assumption you want to test.</p>}
      </div>)}
    </div>
    {page && canJump && <button type="button" onClick={() => {
      const scroller = element.current;
      if (!scroller) return;
      scroller.focus({ preventScroll: true });
      scroller.scrollTop = scroller.scrollHeight;
      record(scroller);
    }}>{page.page.hasMore ? 'Jump to end of page' : 'Jump to latest message'}</button>}
  </>;
}
