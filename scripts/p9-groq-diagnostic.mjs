// Standalone local diagnostic. The P9 API and worker do not load this module or its key file.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

const confirmation = 'approve-one-fictional-groq-request';
const endpoint = 'https://api.groq.com/openai/v1/chat/completions';
const model = 'openai/gpt-oss-20b';
const prompt = 'A fictional shop sells blue kites. Suggest one fictional shop name.';

function requireAuthorization(environment) {
  if (environment.NODE_ENV === 'production' || environment.FL_P9_GROQ_DIAGNOSTIC_CONFIRM !== confirmation) {
    throw new Error('DIAGNOSTIC_NOT_AUTHORIZED');
  }
}

/** Check local key syntax only. Account and model permissions are decided by Groq. */
export function validGroqKey(key) {
  return typeof key === 'string' && key.startsWith('gsk_') && key.length >= 24 && key.length <= 256 &&
    !/[^A-Za-z0-9_-]/.test(key) && !/(?:placeholder|replace|your[_-]?key)/i.test(key);
}

function measuredUsage(usage) {
  const inputTokens = usage?.prompt_tokens;
  const outputTokens = usage?.completion_tokens;
  const totalTokens = usage?.total_tokens;
  if ([inputTokens, outputTokens, totalTokens].every(value => Number.isSafeInteger(value) && value >= 0) &&
    inputTokens + outputTokens === totalTokens) return { inputTokens, outputTokens, totalTokens };
}

/** Make one text-only POST. Report fixed outcomes and validated counts, even when the reply is malformed. */
export async function runGroqDiagnostic(environment, key, transport = fetch) {
  requireAuthorization(environment);
  if (!validGroqKey(key)) throw new Error('DIAGNOSTIC_KEY_UNAVAILABLE');
  let httpStatus;
  try {
    // Native fetch has no SDK retry policy. Redirects are rejected before another request.
    const response = await transport(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }],
        stream: false, max_completion_tokens: 256 })
    });
    httpStatus = response.status;
    if (!response.ok) {
      await response.body?.cancel();
      return { result: 'REJECTED', httpStatus, validText: false };
    }
    const body = await response.json();
    const choice = Array.isArray(body?.choices) && body.choices.length === 1 ? body.choices[0] : undefined;
    const text = choice?.message?.content;
    const validText = choice?.finish_reason === 'stop' && choice.message?.role === 'assistant' &&
      typeof text === 'string' && text.trim().length > 0;
    const usage = measuredUsage(body?.usage);
    return { result: validText ? 'ACCEPTED' : 'INVALID_RESPONSE', httpStatus, validText, ...(usage && { usage }) };
  } catch {
    // Never forward errors from fetch or parsing. They may contain sensitive response data.
    return { result: 'UNCONFIRMED', ...(httpStatus !== undefined && { httpStatus }), validText: false };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    requireAuthorization(process.env);
    // Read the dedicated worker-side file directly. Ambient provider keys are ignored.
    const workerEnv = parseEnv(await readFile(new URL('../.env.p9-groq-worker.local', import.meta.url), 'utf8'));
    const result = await runGroqDiagnostic(process.env, workerEnv.GROQ_API_KEY);
    console.log(JSON.stringify(result));
    if (result.result !== 'ACCEPTED') process.exitCode = 1;
  } catch (error) {
    console.error(error?.message === 'DIAGNOSTIC_NOT_AUTHORIZED'
      ? 'DIAGNOSTIC_NOT_AUTHORIZED' : 'DIAGNOSTIC_CONFIGURATION_UNAVAILABLE');
    process.exitCode = 1;
  }
}
