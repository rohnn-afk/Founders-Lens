// Next.js UI root. This React layout wraps each page with the shared HTML
// shell and supplies metadata, such as the title shown in the browser tab.

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ClerkProvider } from '@clerk/nextjs';
import './globals.css';

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
      <body>
        {clerkConfigured ? (
          <ClerkProvider signInUrl="/sign-in" afterSignOutUrl="/sign-in">
            {children}
          </ClerkProvider>
        ) : children}
      </body>
    </html>
  );
}
