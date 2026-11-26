import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { founderInstructions, founderPromptVersion } from '../apps/worker/dist/founder-provider.js';
import { groqFounderProvider } from '../apps/worker/dist/groq-provider.js';
import { freeGroqPolicy } from '../apps/worker/dist/groq-free-policy.js';

const key = 'gsk_' + 'offline_synthetic_fixture';
const prompt = { version: founderPromptVersion, data: '{"recent":[],"current":"Synthetic founder turn"}' };
const freeEnv = { FL_P9_ISOLATED: '1', FL_GROQ_ORG_PLAN: 'free',
  FL_GROQ_ORG_RPM: '30', FL_GROQ_ORG_RPD: '1000', FL_GROQ_ORG_TPM: '8000', FL_GROQ_ORG_TPD: '200000' };

test('live Groq evaluation requires an explicit case before loading credentials', () => {
  const result = spawnSync(process.execPath, ['scripts/evaluate-groq-free.mjs', '--live'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires one case ID/);
  assert.equal(result.stdout, '');
});

test('Groq Free clamps limits and requires the isolated confirmed organization', () => {
  assert.deepEqual(freeGroqPolicy(freeEnv).limits, { rpm: 10, rpd: 40, tpm: 6000, tpd: 120000 });
  assert.equal(freeGroqPolicy({ ...freeEnv, FL_GROQ_ORG_RPD: '5' }).limits.rpd, 5);
  assert.throws(() => freeGroqPolicy({ ...freeEnv, FL_GROQ_ORG_PLAN: undefined }));
  assert.throws(() => freeGroqPolicy({ ...freeEnv, FL_DEPLOYMENT: 'staging' }));
  assert.throws(() => freeGroqPolicy({ ...freeEnv, FL_GROQ_FREE_MODEL: 'unapproved' }));
});

test('Groq Free reserves before a strict request and settles usage even for rejected content', async () => {
  const attempts = [];
  const policy = freeGroqPolicy(freeEnv);
  let mode = 'valid';
  const provider = groqFounderProvider(key, async (_url, options) => {
    attempts.push('post');
    const body = JSON.parse(options.body);
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.stream, false);
    assert.equal(body.max_completion_tokens, 1200);
    if (mode === 'limited') return new Response(null, { status: 429, headers: { 'Retry-After': '7' } });
    const content = JSON.stringify({ text: 'Test a commitment.', strategy: 'CHALLENGE', question: 'What counts as a commitment?',
      ...(mode === 'invalid' && { inventedSource: 'invalid' }) });
    return Response.json({ id: 'chatcmpl-fixture',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 80, completion_tokens: 50, total_tokens: 130 } });
  }, undefined, { policy, quota: { async reserve() {
    attempts.push('reserve');
    return async (used, delay) => { attempts.push([used, delay]); };
  } } });
  const signal = new AbortController().signal;
  const result = await provider.generate(prompt, signal);
  assert.equal(result.assistantContent.primaryStrategy, 'CHALLENGE');
  mode = 'invalid';
  assert.equal((await provider.generate(prompt, signal)).text, null);
  mode = 'limited';
  await assert.rejects(provider.generate(prompt, signal));
  assert.deepEqual(attempts, ['reserve', 'post', [130, 0], 'reserve', 'post', [130, 0],
    'reserve', 'post', [undefined, 7000]]);
  await assert.rejects(provider.generate({ ...prompt, data: 'x'.repeat(2000) }, signal), /context budget/);
  assert.equal(attempts.length, 9);
});

test('Groq Free drops old turns before reserving and preserves the complete current question', async () => {
  const current = 'What outcome would disprove the idea?';
  let posted;
  const provider = groqFounderProvider(key, async (_url, options) => {
    posted = JSON.parse(JSON.parse(options.body).messages[1].content);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant',
      content: JSON.stringify({ text: 'Test it.', strategy: 'REFLECT', question: 'What will you measure?' }) } }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } });
  }, undefined, { policy: freeGroqPolicy(freeEnv), quota: { async reserve() { return async () => {}; } } });
  await provider.generate({ ...prompt, data: JSON.stringify({ current, recent: [{ user: 'a'.repeat(1700) },
    { user: 'A more recent synthetic turn.' }] }) }, new AbortController().signal);
  assert.deepEqual(posted, { current, recent: [{ user: 'A more recent synthetic turn.' }] });
});

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
