// Think route entry point. Route parameters are opaque URL identifiers.
// Pass the idea ID to the view, where the workspace controller checks scope.
import { ThinkView } from '../../../../../features/workspace/think-view';

export default async function ThinkPage({ params }: { params: Promise<{ ideaId: string }> }) {
  const { ideaId } = await params;
  return <ThinkView ideaId={ideaId} />;
}
