// Synthetic generation context boundary. Decodes the bounded repository
// projection and produces a deterministic reply without any external I/O.
type Source = { id: string; text: string; truncated: boolean };
type Turn = { user: Source; assistant?: Source };
type Memory = Source & { version: number };
export type GenerationContext = { current: Source; previous: Turn[]; memory: Memory[] };
export type OfflineAssistantContent = {
  schemaVersion: 1; primaryStrategy: 'CHALLENGE' | 'REFLECT'; nextQuestion: string;
  citationRefs: []; proposalIds: []; actions: [];
  card?: { type: 'experiment'; hypothesis: string; plan: string; successSignals: string[]; timebox: string };
};

/** Only server-controlled metadata is derived from authorized context. */
export function offlineAssistantContent(context: GenerationContext): OfflineAssistantContent {
  const priorTurn = context.previous.length > 0;
  return { schemaVersion: 1, primaryStrategy: priorTurn ? 'REFLECT' : 'CHALLENGE',
    nextQuestion: priorTurn ? 'What changed since your previous test?' : 'What result would disprove this assumption?',
    ...(priorTurn && { card: { type: 'experiment' as const,
      hypothesis: 'Changing one condition will improve the outcome compared with the original test.',
      plan: 'Keep the original test as a baseline. Change one condition and record the same outcome in both groups.',
      successSignals: ['The difference meets a threshold chosen before collecting results.'],
      timebox: 'One test round' } }),
    citationRefs: [], proposalIds: [], actions: [] };
}

const uuid = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function source(value: unknown, max: number): Source | undefined {
  if (!object(value) || typeof value.id !== 'string' || !uuid.test(value.id) ||
    typeof value.text !== 'string' || !value.text.length || !value.text.isWellFormed() ||
    value.text.includes('\0') || Array.from(value.text).length > max || typeof value.truncated !== 'boolean') return;
  return { id: value.id, text: value.text, truncated: value.truncated };
}

export async function assembleGenerationContext(read: () => Promise<unknown>, triggerMessageId: string): Promise<GenerationContext | undefined> {
  const value = await read();
  if (!object(value) || !Array.isArray(value.previous) || value.previous.length > 3 ||
    !Array.isArray(value.memory) || value.memory.length > 3) return;
  const current = source(value.current, 1200);
  if (!current || current.id !== triggerMessageId) return;
  const previous: Turn[] = [];
  const memory: Memory[] = [];
  for (const turn of value.previous) {
    if (!object(turn)) return;
    const user = source(turn.user, 600);
    const assistant = turn.assistant == null ? undefined : source(turn.assistant, 600);
    if (!user || user.id === current.id || (turn.assistant != null && !assistant)) return;
    previous.push(assistant ? { user, assistant } : { user });
  }
  for (const row of value.memory) {
    const item = source(row, 400);
    if (!item || !object(row) || typeof row.version !== 'number' || !Number.isSafeInteger(row.version) || row.version < 1) return;
    memory.push({ ...item, version: row.version });
  }
  return { current, previous, memory };
}

export async function syntheticContextResponse(context: GenerationContext): Promise<string> {
  const previous = context.previous.at(-1);
  const memory = context.memory.at(-1);
  const quote = (item: Source) => '“' + item.text + (item.truncated ? '…' : '') + '”';
  return [
    'Synthetic assistant. Current founder statement: ' + quote(context.current),
    ...(previous ? ['Earlier founder statement: ' + quote(previous.user)] : []),
    ...(memory ? ['Reviewed idea memory: ' + quote(memory)] : []),
    previous?.assistant
      ? 'What would you change about the previous test in light of this update?'
      : 'What would you test first to check this assumption?'
  ].join('\n');
}
