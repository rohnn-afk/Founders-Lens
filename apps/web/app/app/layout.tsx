// Workspace route boundary. A verified Clerk session can reach the shell.
// The existing workspace provider receives no private data or API adapters.
import { auth } from '@clerk/nextjs/server';
import { notFound, redirect } from 'next/navigation';
import { Suspense, type ReactNode } from 'react';
import { publicDemo } from '../../app-mode';
import { WorkspaceProvider } from '../../features/workspace/workspace-provider';
import { LocalWorkspace } from '../../features/workspace/read-only-ideas';

async function SignedInShell({ children }: { children: ReactNode }) {
  let signedIn: boolean;
  try {
    const { userId, sessionId } = await auth({ treatPendingAsSignedOut: true });
    signedIn = Boolean(userId && sessionId);
  } catch {
    return <p role="alert">Unable to verify your session. Reload to try again.</p>;
  }
  if (!signedIn) redirect('/sign-in');

  // A Clerk session grants access to this shell. Private workspace access
  // requires the separate Express identity, suppression and admission gates.
  return <LocalWorkspace>{children}</LocalWorkspace>;
}

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  if (publicDemo) notFound();
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || !process.env.CLERK_SECRET_KEY) {
    return <WorkspaceProvider>{children}</WorkspaceProvider>;
  }
  return (
    <Suspense fallback={<p role="status">Checking your session…</p>}>
      <SignedInShell>{children}</SignedInShell>
    </Suspense>
  );
}
