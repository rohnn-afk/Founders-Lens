// Idea index route. The route delegates rendering and data access to the
// chooser, which can render only inside an available workspace session.
import { IdeaChooser } from '../../features/workspace/idea-chooser';

export default function WorkspacePage() {
  return <IdeaChooser />;
}
