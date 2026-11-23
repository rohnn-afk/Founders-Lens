/** Worker-only Groq adapter. It reports observations through the existing provider contract. */
import { founderInstructions, validatePrompt, type FounderProvider, type ProviderUsage } from './founder-provider.js';

const endpoint = 'https://api.groq.com/openai/v1/chat/completions';
const model = 'openai/gpt-oss-20b';
const outputTokens = 1024;
const inputTokens = 4224;
const httpRejection = {
  400: 'GROQ_INVALID_REQUEST', 401: 'GROQ_UNAUTHENTICATED', 403: 'GROQ_PERMISSION_DENIED',
  404: 'GROQ_NOT_FOUND', 429: 'GROQ_RATE_LIMITED'
} as const;
type GroqDiagnostic = typeof httpRejection[keyof typeof httpRejection] | 'GROQ_PROVIDER_UNAVAILABLE' |
  'GROQ_HTTP_REJECTED' | 'GROQ_TIMEOUT' | 'GROQ_ABORTED' | 'GROQ_TRANSPORT_FAILURE' |
  'GROQ_MALFORMED_RESPONSE' | 'GROQ_COMPLETION_TRUNCATED' | 'GROQ_COMPLETION_NOT_STOPPED' |
  'GROQ_EMPTY_FINAL_CONTENT' | 'GROQ_REASONING_ONLY' | 'GROQ_UNSAFE_FINAL_CONTENT' |
  'GROQ_USAGE_MISSING' | 'GROQ_USAGE_INVALID' | 'GROQ_USAGE_OUT_OF_BOUNDS';

function rejection(status: number): GroqDiagnostic {
  if (Object.hasOwn(httpRejection, status)) return httpRejection[status as keyof typeof httpRejection];
  return status >= 500 ? 'GROQ_PROVIDER_UNAVAILABLE' : 'GROQ_HTTP_REJECTED';
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

function tokens(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2147483647;
}

/** Only a consistent provider observation can settle a usage reservation. */
function readUsage(value: unknown): ProviderUsage | null {
  const usage = object(value);
  const input = usage?.['prompt_tokens'], output = usage?.['completion_tokens'], total = usage?.['total_tokens'];
  return tokens(input) && tokens(output) && tokens(total) && input + output === total
    ? { inputTokens: input, outputTokens: output, totalTokens: total } : null;
}

/** Only final assistant content from a completed choice is eligible for publication. */
function completionFailure(choice: Record<string, unknown> | undefined, apiKey: string): GroqDiagnostic | undefined {
  const finish = choice?.['finish_reason'];
  if (finish === 'length') return 'GROQ_COMPLETION_TRUNCATED';
  const message = object(choice?.['message']);
  if (typeof finish !== 'string' || message?.['role'] !== 'assistant') return 'GROQ_MALFORMED_RESPONSE';
  if (finish !== 'stop') return 'GROQ_COMPLETION_NOT_STOPPED';
  const content = message['content'];
  if (content != null && typeof content !== 'string') return 'GROQ_MALFORMED_RESPONSE';
  if (typeof content !== 'string' || !content.trim()) {
    const reasoning = message['reasoning'];
    return typeof reasoning === 'string' && reasoning.trim() ? 'GROQ_REASONING_ONLY' : 'GROQ_EMPTY_FINAL_CONTENT';
  }
  if (!content.isWellFormed() || content.includes('\0') || content.includes(apiKey) ||
    Array.from(content).length > 10_000) return 'GROQ_UNSAFE_FINAL_CONTENT';
}

/** Construct a single-POST text provider. A reported rejection is never proof of zero spend. */
export function groqFounderProvider(apiKey: string | undefined, transport: typeof fetch = fetch,
  report: (event: GroqDiagnostic) => void = () => {}): FounderProvider {
  if (typeof apiKey !== 'string' || !apiKey.startsWith('gsk_') || apiKey.length < 24 || apiKey.length > 256 ||
    /[^A-Za-z0-9_-]/.test(apiKey) || /(?:placeholder|replace|your[_-]?key)/i.test(apiKey)) {
    throw new Error('Approved worker Groq configuration is unavailable');
  }
  const fail = (event: GroqDiagnostic): never => {
    report(event);
    throw new Error('Groq invocation outcome is unavailable');
  };
  return { async generate(prompt, signal) {
    validatePrompt(prompt);
    signal.throwIfAborted();
    // Leave time for a classified provider timeout before the worker's 9s wall-clock fence.
    const timeout = AbortSignal.timeout(8_000);
    const signalForRequest = AbortSignal.any([signal, timeout]);
    const interrupted = () => signal.aborted ? 'GROQ_ABORTED' : timeout.aborted ? 'GROQ_TIMEOUT' : undefined;
    let response: Response;
    try {
      response = await transport(endpoint, {
        method: 'POST', redirect: 'error', signal: signalForRequest,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [
          { role: 'system', content: founderInstructions }, { role: 'user', content: prompt.data }
        ], stream: false, max_completion_tokens: outputTokens, reasoning_effort: 'low', include_reasoning: false })
      });
    } catch { return fail(interrupted() ?? 'GROQ_TRANSPORT_FAILURE'); }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return fail(rejection(response.status));
    }

    let value: unknown;
    try { value = await response.json(); }
    catch { return fail(interrupted() ?? 'GROQ_MALFORMED_RESPONSE'); }
    const body = object(value);
    const choices = body?.['choices'];
    const choice = Array.isArray(choices) && choices.length === 1 ? object(choices[0]) : undefined;
    const message = object(choice?.['message']);
    const text = message?.['content'];
    const usage = readUsage(body?.['usage']);
    const id = body?.['id'];
    const responseId = typeof id === 'string' && /^chatcmpl-[A-Za-z0-9_.:-]{1,140}$/.test(id) && !id.includes(apiKey) ? id : null;
    const completionError = completionFailure(choice, apiKey);
    const usageError = !usage ? body?.['usage'] == null ? 'GROQ_USAGE_MISSING' : 'GROQ_USAGE_INVALID'
      : usage.inputTokens > inputTokens || usage.outputTokens > outputTokens ? 'GROQ_USAGE_OUT_OF_BOUNDS' : undefined;
    if (completionError) report(completionError);
    if (usageError) report(usageError);
    // Completion rejection and metering are independent facts; keep valid usage even without text.
    return { text: !completionError && !usageError && typeof text === 'string' ? text : null, usage, responseId };
  } };
}
