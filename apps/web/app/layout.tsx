// Next.js UI root. This React layout wraps each page with the shared HTML
// shell and supplies metadata, such as the title shown in the browser tab.

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: "Founder's Lens",
  description: "Founder's Lens local workspace placeholder."
};

// Next.js passes the selected page as children. Shared document settings
// belong here so individual pages can focus on their content.
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif' }}>{children}</body>
    </html>
  );
}
