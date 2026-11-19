// Selected conversation view. It displays metadata only after the controller
// verifies both the route's idea and the conversation's parent relationship.
'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { readConversation } from './read-controller';
import { readNotice, useWorkspaceRead } from './workspace-provider';
import type { useWorkspace } from './workspace-provider';

export function ConversationView({ ideaId, conversationId }: { ideaId: string; conversationId: string }) {
  const [revision, setRevision] = useState(0);
  const load = useCallback(({ reads, api, scope }: ReturnType<typeof useWorkspace>) => {
    void revision;
    return readConversation(reads, api, scope, ideaId, conversationId);
  }, [conversationId, ideaId, revision]);
  const result = useWorkspaceRead(load);
  if (result.kind !== 'ready') return <><h1>Conversation</h1>{readNotice(result.kind, () => setRevision(value => value + 1))}</>;
  const { idea, conversation } = result.data;
  return <>
    <h1>{conversation.title || 'Untitled conversation'}</h1>
    <p>{idea.title}</p>
    {(idea.status === 'ARCHIVED' || conversation.status === 'ARCHIVED') && <p role="status">Archived (read only)</p>}
    <Link prefetch={false} href={'/app/ideas/' + encodeURIComponent(ideaId) + '/think'}>Back to Think</Link>
  </>;
}
