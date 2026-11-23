import assert from 'node:assert/strict';
import test from 'node:test';
import { founderInstructions, founderPromptVersion } from '../apps/worker/dist/founder-provider.js';
import { groqFounderProvider } from '../apps/worker/dist/groq-provider.js';

const key = 'gsk_' + 'offline_synthetic_fixture';
const prompt = { version: founderPromptVersion, data: '{"recent":[],"current":"Synthetic founder turn"}' };

test('Groq sends one bounded chat completion and preserves measured token counts', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Ambient network disabled'));
  let calls = 0;
  const provider = groqFounderProvider(key, async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(new Headers(options.headers).get('Authorization') === 'Bearer ' + key, true);
    assert.deepEqual(JSON.parse(options.body), { model: 'openai/gpt-oss-20b',
      messages: [{ role: 'system', content: founderInstructions }, { role: 'user', content: prompt.data }],
      stream: false, max_completion_tokens: 1024, reasoning_effort: 'low', include_reasoning: false });
    return Response.json({ id: 'chatcmpl-fixture', choices: [
      { finish_reason: 'stop', message: { role: 'assistant', content: 'Try a paid pilot.' } }
    ], usage: { prompt_tokens: 85, completion_tokens: 130, total_tokens: 215 } });
  });
  assert.deepEqual(await provider.generate(prompt, new AbortController().signal), {
    text: 'Try a paid pilot.', responseId: 'chatcmpl-fixture', usage: { inputTokens: 85, outputTokens: 130, totalTokens: 215 }
  });
  assert.equal(calls, 1);
});

test('Groq rejects once and classifies failures without exposing provider data', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Ambient network disabled'));
  for (const [status, diagnostic] of [[400, 'GROQ_INVALID_REQUEST'], [401, 'GROQ_UNAUTHENTICATED'],
    [403, 'GROQ_PERMISSION_DENIED'], [404, 'GROQ_NOT_FOUND'], [429, 'GROQ_RATE_LIMITED'],
    [503, 'GROQ_PROVIDER_UNAVAILABLE'], [0, 'GROQ_TRANSPORT_FAILURE']]) {
    let calls = 0;
    const events = [];
    const provider = groqFounderProvider(key, async () => {
      calls++;
      if (!status) throw new Error(key);
      return new Response(key, { status });
    }, event => events.push(event));
    await assert.rejects(provider.generate(prompt, new AbortController().signal),
      { message: 'Groq invocation outcome is unavailable' });
    assert.equal(calls, 1);
    assert.deepEqual(events, [diagnostic]);
  }
  assert.throws(() => groqFounderProvider('bad key'), /configuration is unavailable/);
});

test('Groq distinguishes timeout from transport loss with one attempt', async t => {
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    assert.equal(milliseconds, 8000);
    return AbortSignal.abort();
  });
  let calls = 0;
  const events = [];
  const provider = groqFounderProvider(key, async (_url, options) => {
    calls++;
    options.signal.throwIfAborted();
    assert.fail('Expected timeout signal');
  }, event => events.push(event));
  await assert.rejects(provider.generate(prompt, new AbortController().signal), /outcome is unavailable/);
  assert.equal(calls, 1);
  assert.deepEqual(events, ['GROQ_TIMEOUT']);
});

test('Groq distinguishes cap exhaustion from a complete answer at the exact cap', async () => {
  const observation = { id: 'chatcmpl-fixture', choices: [
    { finish_reason: 'length', message: { role: 'assistant', content: 'Partial answer', reasoning: 'Private chain' } }
  ], usage: { prompt_tokens: 273, completion_tokens: 1024, total_tokens: 1297,
    completion_tokens_details: { reasoning_tokens: 900 } } };
  const events = [];
  const provider = groqFounderProvider(key, async () => Response.json(observation), event => events.push(event));
  const usage = { inputTokens: 273, outputTokens: 1024, totalTokens: 1297 };
  assert.deepEqual(await provider.generate(prompt, new AbortController().signal), {
    text: null, responseId: 'chatcmpl-fixture', usage
  });
  assert.deepEqual(events, ['GROQ_COMPLETION_TRUNCATED']);
  observation.choices[0].finish_reason = 'stop';
  observation.choices[0].message.content = 'Complete answer';
  assert.deepEqual(await provider.generate(prompt, new AbortController().signal), {
    text: 'Complete answer', responseId: 'chatcmpl-fixture', usage
  });
  assert.deepEqual(events, ['GROQ_COMPLETION_TRUNCATED']);
});

test('Groq separates empty text, reasoning-only, malformed choices, and unusable metering', async () => {
  const assistant = content => ({ finish_reason: 'stop', message: { role: 'assistant', content } });
  const validUsage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
  for (const [choices, usage, diagnostic, retainsUsage] of [
    [[assistant('  ')], validUsage, 'GROQ_EMPTY_FINAL_CONTENT', true],
    [[{ finish_reason: 'stop', message: { role: 'assistant', content: null, reasoning: 'Private reasoning' } }],
      validUsage, 'GROQ_REASONING_ONLY', true],
    [undefined, validUsage, 'GROQ_MALFORMED_RESPONSE', true],
    [[assistant(['unexpected'])], validUsage, 'GROQ_MALFORMED_RESPONSE', true],
    [[assistant('Final')], undefined, 'GROQ_USAGE_MISSING', false],
    [[assistant('Final')], { ...validUsage, total_tokens: 1 }, 'GROQ_USAGE_INVALID', false],
    [[assistant('Final')], { prompt_tokens: 10, completion_tokens: 1025, total_tokens: 1035 },
      'GROQ_USAGE_OUT_OF_BOUNDS', true]
  ]) {
    const events = [];
    const provider = groqFounderProvider(key, async () => Response.json({ choices, usage }), event => events.push(event));
    const result = await provider.generate(prompt, new AbortController().signal);
    assert.equal(result.text, null);
    assert.equal(result.usage?.totalTokens ?? null, retainsUsage ? usage.total_tokens : null);
    assert.deepEqual(events, [diagnostic]);
  }
});
