// Workspace route layout. This Server Component composes the client boundary
// without supplying private data, provider credentials, or a test adapter.
import type { ReactNode } from 'react';
import { WorkspaceProvider } from '../../features/workspace/workspace-provider';

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return <WorkspaceProvider>{children}</WorkspaceProvider>;
}
