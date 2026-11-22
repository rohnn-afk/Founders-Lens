// Workspace route boundary. A verified Clerk session can reach the shell.
// The existing workspace provider receives no private data or API adapters.
import { SignOutButton } from '@clerk/nextjs';
import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { Suspense, type ReactNode } from 'react';
import { WorkspaceProvider } from '../../features/workspace/workspace-provider';

async function SignedInShell() {
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
  return (
    <main style={{ maxWidth: '48rem', margin: '3rem auto', padding: '0 1.5rem' }}>
      <h1>Workspace</h1>
      <p role="status">You are signed in. Workspace data is currently unavailable.</p>
      <SignOutButton redirectUrl="/sign-in"><button type="button">Sign out</button></SignOutButton>
    </main>
  );
}

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || !process.env.CLERK_SECRET_KEY) {
    return <WorkspaceProvider>{children}</WorkspaceProvider>;
  }
  return (
    <Suspense fallback={<p role="status">Checking your session…</p>}>
      <SignedInShell />
    </Suspense>
  );
}
