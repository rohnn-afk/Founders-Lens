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

test('approved memory enters only the explicitly offline prompt and omits truncated revisions', () => {
  const context = { current: source('What should we test?'), previous: [],
    memory: [{ ...source('The owner approved this revision.'), version: 2 },
      { ...source('Incomplete memory text', true), version: 1 }] };
  assert.equal(JSON.parse(founderPrompt(context).data).approvedMemory, undefined);
  assert.deepEqual(JSON.parse(founderPrompt(context, true).data).approvedMemory,
    [{ text: 'The owner approved this revision.', version: 2 }]);
});

test('contextual offline replies use bounded authorized turns and distinguish follow-ups', async () => {
  const provider = deterministicFounderProvider({ contextual: true });
  const signal = new AbortController().signal;
  const first = await provider.generate(input('Will tenants pay for reusable kits?'), signal);
  const followUp = await provider.generate(founderPrompt({
    current: source('What would change the test?'),
    previous: [{ user: source('Will tenants pay for reusable kits?'), assistant: source('Measure actual reservations.') }], memory: []
  }), signal);
  assert.notEqual(followUp.text, first.text);
  assert.match(followUp.text, /Will tenants pay for reusable kits/);
  assert.match(followUp.text, /What would change the test/);
  assert.match(followUp.text, /The previous reply suggested “Measure actual reservations\.”/);
  assert.match(followUp.text, /same outcome for both groups/);
  assert.equal(followUp.usage, null);
  assert.equal(followUp.responseId, null);
});
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
  const previousVersion = process.env.GOOGLE_GENAI_API_VERSION;
  process.env.GOOGLE_GENAI_API_VERSION = 'v1beta';
  t.after(() => {
    if (previousVersion === undefined) delete process.env.GOOGLE_GENAI_API_VERSION;
    else process.env.GOOGLE_GENAI_API_VERSION = previousVersion;
  });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Ambient network disabled'); });
  let calls = 0;
  const provider = geminiFounderProvider(env, async (url, options) => {
    calls++;
    const target = new URL(typeof url === 'string' || url instanceof URL ? url : url.url);
    assert.equal(target.origin, 'https://generativelanguage.googleapis.com');
    assert.equal(options.redirect, 'error');
    assert.equal(target.pathname, '/v1/models/gemini-3.1-flash-lite:generateContent');
    assert.equal(new Headers(options.headers).get('X-Server-Timeout'), '9');
    const body = JSON.parse(options.body);
    assert.equal(options.method, 'POST');
    assert.deepEqual(body, {
      contents: [{ role: 'user', parts: [{ text: input('Synthetic pricing').data }] }],
      systemInstruction: { role: 'user', parts: [{ text: founderInstructions }] },
      generationConfig: { maxOutputTokens: 512, candidateCount: 1, thinkingConfig: { thinkingLevel: 'MINIMAL' } }
    });
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

test('Gemini emits only allowlisted rejection events supported by structured HTTP errors', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Ambient network disabled'); });
  const invalidKey = { '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
    domain: 'googleapis.com', reason: 'API_KEY_INVALID' };
  for (const [httpStatus, status, category, details = [], code = httpStatus] of [
    [400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT'],
    [400, 'FAILED_PRECONDITION', 'FAILED_PRECONDITION'],
    [400, 'INVALID_ARGUMENT', 'INVALID_API_KEY', [invalidKey]],
    [404, 'NOT_FOUND', 'NOT_FOUND'],
    [429, 'RESOURCE_EXHAUSTED', 'RESOURCE_EXHAUSTED'],
    [400, 'FAILED_PRECONDITION', '400', [], 429],
    [403, 'PERMISSION_DENIED', null, [{ ...invalidKey, domain: 'fixture.invalid' }]],
    [503, 'UNAVAILABLE', null],
  ]) {
    let calls = 0;
    const events = [];
    const provider = geminiFounderProvider(env, async () => {
      calls++;
      return Response.json({ error: { code, status,
        message: 'API_KEY_INVALID Synthetic private prompt ' + standardKey,
        details: [...details, { responseId: 'fixture.response' }] } }, { status: httpStatus });
    }, event => events.push(event));
    await assert.rejects(provider.generate(input('Synthetic founder turn'), new AbortController().signal), error => {
      assert.equal(error.message, httpStatus === 400 ? 'Gemini rejected the generation request (HTTP 400)'
        : 'Gemini invocation outcome is unavailable');
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(calls, 1);
    assert.deepEqual(events, category ? [`GEMINI_REQUEST_REJECTED_${category}`] : []);
  }
});

test('Gemini identifies only allowlisted fields in a structured BadRequest detail', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Ambient network disabled'); });
  let calls = 0;
  const events = [];
  const prompt = input('Synthetic founder turn');
  const provider = geminiFounderProvider(env, async (_url, request) => {
    calls++;
    assert.equal(JSON.parse(request.body).generationConfig.thinkingConfig.thinkingLevel, 'MINIMAL');
    // Simulated field rejection exercises diagnostics, independent of live model behavior.
    return Response.json({ error: { code: 400, status: 'INVALID_ARGUMENT', message: standardKey, details: [
      { '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [
        { field: 'generationConfig.thinkingConfig.thinkingLevel', description: prompt.data },
        { field: 'generation_config.thinking_config.thinking_level', description: standardKey },
        { field: 'system_instruction.role', description: 'private provider text' },
        { field: 'generationConfig.maxOutputTokens', description: 'private provider text' },
        { field: 'generation_config.candidate_count' },
        { field: 'contents[0].role' },
        { field: 'contents[0].parts[0].text' },
        { field: standardKey }, { field: prompt.data }, null
      ] },
      { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', fieldViolations: [{ field: 'model' }] }
    ] } }, { status: 400 });
  }, event => events.push(event));
  await assert.rejects(provider.generate(prompt, new AbortController().signal),
    { message: 'Gemini rejected the generation request (HTTP 400)' });
  assert.equal(calls, 1);
  assert.deepEqual(events, [
    'GEMINI_REQUEST_INVALID_FIELD_THINKING_LEVEL', 'GEMINI_REQUEST_INVALID_FIELD_SYSTEM_INSTRUCTION_ROLE',
    'GEMINI_REQUEST_INVALID_FIELD_MAX_OUTPUT_TOKENS', 'GEMINI_REQUEST_INVALID_FIELD_CANDIDATE_COUNT',
    'GEMINI_REQUEST_INVALID_FIELD_CONTENT_ROLE', 'GEMINI_REQUEST_INVALID_FIELD_CONTENT_TEXT',
    'GEMINI_REQUEST_REJECTED_INVALID_ARGUMENT'
  ]);
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
