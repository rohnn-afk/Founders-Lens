// Conversation route entry point. Pass both URL identifiers to the view
// so it can check the returned conversation belongs to the requested idea.
import { ConversationView } from '../../../../../../features/workspace/conversation-view';

type Params = { ideaId: string; conversationId: string };

export default async function ConversationPage({ params }: { params: Promise<Params> }) {
  const { ideaId, conversationId } = await params;
  return <ConversationView ideaId={ideaId} conversationId={conversationId} />;
}
