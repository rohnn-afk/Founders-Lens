// No live provider I/O. The SDK runs through an in-process stub to exercise
// retry policy, response metering and sanitization at its actual boundary.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { deterministicFounderProvider, founderInstructions, founderPrompt, founderPromptVersion,
  geminiFounderProvider, syntheticOnlyProvider } from '../apps/worker/dist/founder-provider.js';

const source = (text, truncated = false) => ({ id: 'fixture', text, truncated });
const input = text => founderPrompt({ current: source(text), previous: [], memory: [] });
const standardKey = 'AIza' + 'synthetic_fixture'.padEnd(35, '_');
const authorizationKey = 'AQ.synthetic_authorization_fixture';
const env = { P9_GEMINI_API_KEY: standardKey, P9_GEMINI_MODEL: 'gemini-3.1-flash-lite' };

for (const [kind, key] of [['standard', standardKey], ['authorization', authorizationKey]]) {
  test(`the installed SDK sends the ${kind} key unchanged in the API-key header`, async t => {
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('Ambient network disabled'); });
    let calls = 0;
    const provider = geminiFounderProvider({ ...env, P9_GEMINI_API_KEY: key }, async (url, options) => {
      calls++;
      const headers = new Headers(options.headers);
      assert.equal(headers.get('x-goog-api-key'), key);
      assert.equal(headers.has('authorization'), false);
      assert.equal(String(url).includes(key), false);
      assert.equal(String(options.body).includes(key), false);
      return Response.json({ responseId: key, candidates: [{ finishReason: 'STOP',
        content: { parts: [{ text: 'Unexpected echo: ' + key }] } }],
      usageMetadata: { promptTokenCount: 9, totalTokenCount: 12 } });
    });
    assert.deepEqual(await provider.generate(input('Synthetic pricing'), new AbortController().signal), {
      text: null, responseId: null, usage: { inputTokens: 9, outputTokens: 3, totalTokens: 12 }
    });
    assert.equal(calls, 1);
  });
}

test('Gemini key validation rejects placeholders, malformed values and unsafe header characters', () => {
  for (const key of [undefined, '', 'YOUR_GEMINI_API_KEY_HERE', 'AQ.placeholder_fixture',
    'AQ.short', 'AQ.' + 'a'.repeat(198), 'AIza.short', 'AQ.' + 'a'.repeat(20) + '.extra',
    standardKey + '\n', authorizationKey + '\r\nInjected: x', authorizationKey + '\0',
    'Bearer ' + authorizationKey, '<' + standardKey + '>', standardKey + ';']) {
    assert.throws(() => geminiFounderProvider({ ...env, P9_GEMINI_API_KEY: key }),
      { message: 'Approved worker Gemini configuration is unavailable' });
  }
});

test('the synthetic provider guard denies altered text and any conversation history before provider I/O', async () => {
  const text = 'Confirmed synthetic startup exercise';
  let calls = 0;
  const provider = syntheticOnlyProvider({ async generate() {
    calls++;
    return { text: null, usage: null, responseId: null };
  } }, createHash('sha256').update(text).digest('hex'));
  const signal = new AbortController().signal;
  await assert.rejects(provider.generate(input(text + '.'), signal));
  await assert.rejects(provider.generate(founderPrompt({
    current: source(text), previous: [{ user: source('excluded history') }], memory: []
  }), signal));
  assert.equal(calls, 0);
  await provider.generate(input(text), signal);
  assert.equal(calls, 1);
});

test('the P9 prompt preserves the current turn, orders recent context and excludes memory', () => {
  const prompt = founderPrompt({ current: source('Keep my correction'), previous: [
    { user: source('oldest') }, { user: source('earlier'), assistant: source('selected') }, { user: source('latest') }
  ], memory: [source('do not send', false)] });
  assert.equal(prompt.version, founderPromptVersion);
  assert.deepEqual(JSON.parse(prompt.data), { recent: [{ user: 'oldest' }, { user: 'earlier', assistant: 'selected' },
    { user: 'latest' }], current: 'Keep my correction' });
  assert.throws(() => founderPrompt({ current: source('Truncated', true), previous: [], memory: [] }), /input policy/);
  assert.throws(() => input('🦊'.repeat(2000)), /input policy/);
  const bounded = founderPrompt({ current: source('Current'), previous: [{ user: source('🦊'.repeat(2000)) },
    { user: source('Recent') }], memory: [] });
  assert.deepEqual(JSON.parse(bounded.data).recent, [{ user: 'Recent' }]);
});

test('the Gemini SDK uses the pinned model, explicit output budget and one HTTP attempt', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Ambient network disabled'); });
  let calls = 0;
  const provider = geminiFounderProvider(env, async (url, options) => {
    calls++;
    const target = new URL(typeof url === 'string' || url instanceof URL ? url : url.url);
    assert.equal(target.origin, 'https://generativelanguage.googleapis.com');
    assert.equal(options.redirect, 'error');
    assert.match(target.pathname, /gemini-3\.1-flash-lite:generateContent$/);
    const body = JSON.parse(options.body);
    assert.equal(body.generationConfig.maxOutputTokens, 512);
    assert.equal(body.generationConfig.candidateCount, 1);
    assert.equal(body.tools, undefined);
    return Response.json({ responseId: 'fixture.response-1', candidates: [{ finishReason: 'STOP',
      content: { role: 'model', parts: [{ text: 'Test demand with a paid pilot.' }] } }],
    usageMetadata: { promptTokenCount: 37, candidatesTokenCount: 12, thoughtsTokenCount: 2, totalTokenCount: 51 } });
  });
  assert.deepEqual(await provider.generate(input('Synthetic pricing'), new AbortController().signal), {
    text: 'Test demand with a paid pilot.', responseId: 'fixture.response-1',
    usage: { inputTokens: 37, outputTokens: 14, totalTokens: 51 }
  });
  assert.equal(calls, 1);
  await assert.rejects(provider.generate(input('Abort'), AbortSignal.abort()), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('ambiguous Gemini HTTP failure is sanitized and not retried', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Ambient network disabled'); });
  let calls = 0;
  const provider = geminiFounderProvider(env, async () => {
    calls++;
    return Response.json({ error: { code: 503, message: 'private fixture prompt and credentials', status: 'UNAVAILABLE' } }, { status: 503 });
  });
  await assert.rejects(provider.generate(input('Synthetic founder turn'), new AbortController().signal),
    { message: 'Gemini invocation outcome is unavailable' });
  assert.equal(calls, 1);
  assert.throws(() => geminiFounderProvider({}), /configuration is unavailable/);
});

test('metered Gemini replies can be billed even when no complete answer can be published', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Ambient network disabled'); });
  const provider = geminiFounderProvider(env, async () => Response.json({ responseId: 'fixture.truncated',
    candidates: [{ finishReason: 'MAX_TOKENS', content: { role: 'model', parts: [{ text: 'Incomplete' }] } }],
    usageMetadata: { promptTokenCount: 100, totalTokenCount: 612 } }));
  assert.deepEqual(await provider.generate(input('Synthetic development turn'), new AbortController().signal), {
    text: null, responseId: 'fixture.truncated', usage: { inputTokens: 100, outputTokens: 512, totalTokens: 612 }
  });
});

test('the twelve synthetic evaluation prompts are repeatable and ready for manual scoring', async () => {
  const cases = JSON.parse(await readFile(new URL('./fixtures/p9-founder-evaluation.json', import.meta.url), 'utf8'));
  assert.equal(cases.length, 12);
  assert.equal(new Set(cases.map(item => item.id)).size, cases.length);
  assert.match(founderInstructions, /Never invent findings/);
  const fake = deterministicFounderProvider();
  for (const entry of cases) {
    assert.ok(entry.lookFor.length > 10);
    const prompt = input(entry.prompt);
    assert.equal(JSON.parse(prompt.data).current, entry.prompt);
    assert.equal((await fake.generate(prompt, new AbortController().signal)).usage, null);
  }
});
