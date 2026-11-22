// Next.js UI root. This React layout wraps each page with the shared HTML
// shell and supplies metadata, such as the title shown in the browser tab.

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ClerkProvider } from '@clerk/nextjs';
import Link from 'next/link';

export const metadata: Metadata = {
  title: "Founder's Lens",
  description: "A workspace for thoughtful founder decisions."
};

// Next.js passes the selected page as children. Shared document settings
// belong here so individual pages can focus on their content.
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const clerkConfigured = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) && !!process.env.CLERK_SECRET_KEY;
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif' }}>
        {clerkConfigured ? (
          <ClerkProvider signInUrl="/sign-in" afterSignOutUrl="/sign-in">
            <nav aria-label="Account" style={{ padding: '1rem 1.5rem' }}>
              <Link href="/app" prefetch={false}>Open workspace</Link>
            </nav>
            {children}
          </ClerkProvider>
        ) : children}
      </body>
    </html>
  );
}
