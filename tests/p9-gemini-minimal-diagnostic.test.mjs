import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnosticAuthorization, runMinimalGeminiDiagnostic } from '../scripts/p9-gemini-minimal-diagnostic.mjs';

const apiKey = 'AQ.' + 'offline_fixture_example';
const config = { authorization: diagnosticAuthorization, environment: 'test', apiKey };

test('standalone diagnostic defaults off and rejects production before touching transport', async () => {
  const unreachable = () => assert.fail('Transport must remain closed');
  await assert.rejects(runMinimalGeminiDiagnostic({ ...config, authorization: undefined }, unreachable),
    /DIAGNOSTIC_NOT_AUTHORIZED/);
  await assert.rejects(runMinimalGeminiDiagnostic({ ...config, environment: 'production' }, unreachable),
    /DIAGNOSTIC_NOT_AUTHORIZED/);
});

test('SDK emits a pinned v1 request containing only one user text part', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Ambient network must remain closed'));
  let calls = 0;
  const result = await runMinimalGeminiDiagnostic(config, async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://generativelanguage.googleapis.com/v1/models/gemini-3.1-flash-lite:generateContent');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    const headers = new Headers(init.headers);
    assert.equal(headers.has('authorization'), false);
    assert.equal(headers.get('x-goog-api-key') === apiKey, true);
    assert.deepEqual(JSON.parse(init.body), { contents: [{ role: 'user', parts: [
      { text: 'A fictional shop sells blue kites. Suggest one fictional shop name.' }
    ] }] });
    return Response.json({ candidates: [{ content: { parts: [{ text: 'Suppressed fixture answer' }] } }] });
  });
  assert.deepEqual(result, { result: 'ACCEPTED', httpStatus: 200 });
  assert.equal(calls, 1);
});

test('Google 400 diagnostics allowlist details and never echo response text or metadata', async () => {
  const message = 'Unknown field in request: private-account ' + apiKey;
  const result = await runMinimalGeminiDiagnostic(config, async () => Response.json({
    error: { code: 400, status: 'INVALID_ARGUMENT', message, details: [
      { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com',
        metadata: { credential: apiKey } },
      { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: apiKey, domain: message },
      { '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [
        { field: 'contents[0].role', description: message }, { field: apiKey }
      ] }
    ] }
  }, { status: 400 }));
  assert.deepEqual(result, { result: 'REJECTED', httpStatus: 400, googleStatus: 'INVALID_ARGUMENT',
    errorInfo: [{ reason: 'API_KEY_INVALID', domain: 'googleapis.com' }, { reason: 'UNRECOGNIZED', domain: 'UNRECOGNIZED' }],
    fieldViolations: ['contents[0].role', 'UNRECOGNIZED'], messageSummary: 'UNRECOGNIZED_REQUEST_FIELD' });
});

test('a 503 or transport loss never results in a second network call', async () => {
  for (const response of [() => Response.json({ error: { code: 503, status: 'UNAVAILABLE' } }, { status: 503 }),
    () => { throw new Error('Private transport detail'); }]) {
    let calls = 0;
    const result = await runMinimalGeminiDiagnostic(config, async () => {
      calls++;
      return response();
    });
    assert.equal(result.result, 'UNCONFIRMED');
    assert.equal(calls, 1);
  }
});
