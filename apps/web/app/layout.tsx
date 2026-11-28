// Next.js UI root. This React layout wraps each page with the shared HTML
// shell and supplies metadata, such as the title shown in the browser tab.

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ClerkProvider } from '@clerk/nextjs';
import { publicDemo } from '../app-mode';
import { appearanceKey, appearances } from '../features/workspace/appearance';
import './globals.css';

// The document is parsed once, so route navigation never remounts this script.
// Only the workspace styles consume the preference set before hydration.
const initializeAppearance = `(() => {
  try {
    const value = localStorage.getItem(${JSON.stringify(appearanceKey)});
    if (${JSON.stringify(appearances)}.includes(value)) {
      document.documentElement.dataset.workspaceAppearance = value;
    }
  } catch {
    // Workspace styles follow the system when storage is unavailable.
  }
})();`;

export const metadata: Metadata = {
  title: "Founder's Lens",
  description: "A workspace for thoughtful founder decisions."
};

// Next.js passes the selected page as children. Shared document settings
// belong here so individual pages can focus on their content.
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const clerkConfigured = !publicDemo && Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) && !!process.env.CLERK_SECRET_KEY;
  return (
    <html lang="en" suppressHydrationWarning={!publicDemo}>
      {!publicDemo && <head><script dangerouslySetInnerHTML={{ __html: initializeAppearance }} /></head>}
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
