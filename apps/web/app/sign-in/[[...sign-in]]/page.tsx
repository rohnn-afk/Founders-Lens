// Public account entry point. Clerk owns the sign-in UI and session flow,
// while this route keeps redirects inside the Founder's Lens app.
import { SignIn } from '@clerk/nextjs';
import Link from 'next/link';
import { Suspense } from 'react';

export default function SignInPage() {
  const clerkConfigured = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) && !!process.env.CLERK_SECRET_KEY;
  return (
    <main style={{ maxWidth: '48rem', margin: '3rem auto', padding: '0 1.5rem' }}>
      <h1>Sign in to Founder&apos;s Lens</h1>
      {clerkConfigured ? (
        <Suspense fallback={<p role="status">Checking your session…</p>}>
          {/* Clerk owns every step of its catch-all route, including SSO
              callbacks that transition from sign-in to account creation.
              The workspace layout verifies the resulting session. */}
          <SignIn routing="path" path="/sign-in" forceRedirectUrl="/app" signUpForceRedirectUrl="/app"
            fallback={<p role="status">Loading sign-in…</p>} />
        </Suspense>
      ) : <p role="status">Sign-in is unavailable until Clerk is configured.</p>}
      <Link href="/">Return home</Link>
    </main>
  );
}
