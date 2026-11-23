import assert from 'node:assert/strict';
import test from 'node:test';
import { runGroqDiagnostic, validGroqKey } from '../scripts/p9-groq-diagnostic.mjs';

const authorization = { FL_P9_GROQ_DIAGNOSTIC_CONFIRM: 'approve-one-fictional-groq-request' };
const fixtureKey = 'gsk_' + 'offline_synthetic_fixture';

test('Groq diagnostic requires opt-in, a local environment and a well-formed key', async () => {
  const unreachable = () => assert.fail('Transport must remain closed');
  for (const env of [{}, { ...authorization, NODE_ENV: 'production' }]) {
    await assert.rejects(runGroqDiagnostic(env, fixtureKey, unreachable), /DIAGNOSTIC_NOT_AUTHORIZED/);
  }
  for (const key of [undefined, 'gsk_REPLACE_WITH_YOUR_KEY', fixtureKey + '\n', fixtureKey + ' ', 'x' + fixtureKey]) {
    assert.equal(validGroqKey(key), false);
    await assert.rejects(runGroqDiagnostic(authorization, key, unreachable), /DIAGNOSTIC_KEY_UNAVAILABLE/);
  }
  assert.equal(validGroqKey(fixtureKey), true);
});

test('Groq diagnostic serializes one bounded text-only request and reports only status and usage', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Ambient network must remain closed'));
  let calls = 0;
  const result = await runGroqDiagnostic(authorization, fixtureKey, (url, options) => {
    calls++;
    assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.Authorization === 'Bearer ' + fixtureKey, true);
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), { model: 'openai/gpt-oss-20b', stream: false, max_completion_tokens: 256,
      messages: [{ role: 'user', content: 'A fictional shop sells blue kites. Suggest one fictional shop name.' }] });
    return Response.json({ id: 'private-provider-id', choices: [
      { finish_reason: 'stop', message: { role: 'assistant', content: 'Private fixture answer' } }
    ], usage: { prompt_tokens: 25, completion_tokens: 45, total_tokens: 70 }, });
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { result: 'ACCEPTED', httpStatus: 200, validText: true,
    usage: { inputTokens: 25, outputTokens: 45, totalTokens: 70 } });
});

test('Groq rejects errors, redirects and transient or transport failures without another call', async () => {
  for (const [respond, expected] of [
    [() => new Response(fixtureKey, { status: 429 }), { result: 'REJECTED', httpStatus: 429, validText: false }],
    [() => new Response('Private error', { status: 503 }), { result: 'REJECTED', httpStatus: 503, validText: false }],
    [() => { throw new Error('Redirect or connection failed: ' + fixtureKey); }, { result: 'UNCONFIRMED', validText: false }]
  ]) {
    let calls = 0;
    assert.deepEqual(await runGroqDiagnostic(authorization, fixtureKey, () => { calls++; return respond(); }), expected);
    assert.equal(calls, 1);
  }
});

test('Groq does not treat truncated content or malformed metering as a valid result', async () => {
  const result = await runGroqDiagnostic(authorization, fixtureKey, () => Response.json({
    choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'Partial answer' } }],
    usage: { prompt_tokens: 12, completion_tokens: 256, total_tokens: 257 }
  }));
  assert.deepEqual(result, { result: 'INVALID_RESPONSE', httpStatus: 200, validText: false });
});
