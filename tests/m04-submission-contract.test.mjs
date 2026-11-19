// Isolated HTTP contract tests. The router uses a synthetic verification
// boundary and service port so malformed requests cannot reach persistence.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import express from 'express';
import { submissionRoutes } from '../apps/api/dist/submission/routes.js';
import { SubmissionError } from '../apps/api/dist/submission/contracts.js';
import { createSubmissionService } from '../apps/api/dist/submission/service.js';
import { suppressionScopeKey } from '../apps/api/dist/security/suppression-authority.js';
import { unavailableSuppressionAuthority } from '../apps/api/dist/security/suppression-unavailable.js';

const principal = { localUserId: randomUUID(), accountStatus: 'ACTIVE', clerkInstanceId: 'synthetic',
  subjectKeys: [{ version: 1, digest: 'synthetic' }] };
const conversationId = randomUUID(), ideaId = randomUUID();
const body = { clientSubmissionId: randomUUID(), content: 'Synthetic submission' };
const headers = { Authorization: 'Bearer test.only.token', 'Idempotency-Key': 'fixture-key', 'Content-Type': 'application/json' };
const authority = { async lookup(scope, query) {
  return { verdict: 'CLEAR', scope: suppressionScopeKey(scope), nonce: query.nonce, observedAt: Date.now(),
    validUntil: Date.now() + 1000, integrity: 'VERIFIED', coverage: 'COMPLETE', authority: 'INDEPENDENT', epoch: 'synthetic' };
} };

async function harness(t, service) {
  const app = express();
  app.use('/api/v1', submissionRoutes(service, async req => req.get('Authorization') === headers.Authorization ? principal : null));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return async ({ input = JSON.stringify(body), fields = headers, id = conversationId } = {}) => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/v1/conversations/' + id + '/messages',
      { method: 'POST', headers: fields, body: input });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
}

test('isolated submission returns the exact 202 representation and Location', async t => {
  const ref = { messageId: randomUUID(), generationId: randomUUID() };
  const send = await harness(t, { async submit(actor, id, key, input) {
    assert.equal(actor, principal);
    assert.equal(id, conversationId);
    assert.equal(key, 'fixture-key');
    assert.deepEqual(input, body);
    return ref;
  } });
  const result = await send();
  const statusUrl = '/api/v1/generations/' + ref.generationId;
  assert.equal(result.status, 202);
  assert.equal(result.headers.get('location'), statusUrl);
  assert.deepEqual(result.body, { ...ref, status: 'PENDING', statusUrl, eventsUrl: statusUrl + '/events' });
});

test('validates bearer, key, media type, body and Unicode before submission', async t => {
  let calls = 0;
  const send = await harness(t, { async submit(_actor, _id, _key, input) {
    calls++;
    assert.equal(Array.from(input.content).length, 10_000);
    return { messageId: randomUUID(), generationId: randomUUID() };
  } });
  for (const [fields, status] of [
    [{ ...headers, Authorization: '' }, 401],
    [{ ...headers, Authorization: 'Bearer malformed' }, 401],
    [{ ...headers, Authorization: 'Bearer denied.test.token' }, 401],
    [{ ...headers, Cookie: 'fixture=1' }, 401],
    [{ Authorization: headers.Authorization, 'Content-Type': 'application/json' }, 400],
    [{ ...headers, 'Idempotency-Key': 'short' }, 400],
    [{ ...headers, 'Idempotency-Key': 'x'.repeat(129) }, 400],
    [{ ...headers, 'Content-Type': 'text/plain' }, 415]
  ]) assert.equal((await send({ fields })).status, status);
  assert.equal((await send({ id: 'invalid' })).status, 400);
  for (const input of [JSON.stringify({ ...body, ownerId: randomUUID() }), '{', JSON.stringify({ ...body, clientSubmissionId: 'bad' }),
    ...['', '\0', '\uD800', '\uDC00', '\u{1F680}'.repeat(10_001)].map(content => JSON.stringify({ ...body, content }))]) {
    assert.equal((await send({ input })).status, 400);
  }
  assert.equal((await send({ input: JSON.stringify({ ...body, content: 'a'.repeat(140_000) }) })).status, 413);
  assert.equal(calls, 0);
  const escaped = '{"clientSubmissionId":"' + body.clientSubmissionId + '","content":"' + '\\ud83d\\ude80'.repeat(10_000) + '"}';
  assert.equal((await send({ input: escaped, fields: { ...headers, 'Idempotency-Key': 'x'.repeat(128) } })).status, 202);
  assert.equal(calls, 1);
});

test('scope and suppression denials do not call the transaction and are neutral', async t => {
  let scope = { id: conversationId, ideaId, status: 'ACTIVE', idea: { id: ideaId, ownerId: principal.localUserId, status: 'ACTIVE' } };
  const repo = { async scope() { return scope; }, async accept() { assert.fail('Denied request reached transaction'); } };
  const service = createSubmissionService(repo, authority, { clock: () => new Date() });
  const send = await harness(t, service);
  const denials = [null, { ...scope, idea: { ...scope.idea, ownerId: randomUUID() } },
    { ...scope, ideaId: randomUUID() }, { ...scope, status: 'ARCHIVED' }, { ...scope, idea: { ...scope.idea, status: 'ARCHIVED' } }];
  for (const value of denials) {
    scope = value;
    const result = await send();
    assert.equal(result.status, 404);
    assert.equal(result.body.error.code, 'RESOURCE_NOT_FOUND');
  }
  const denied = await harness(t, createSubmissionService(repo, unavailableSuppressionAuthority(), { clock: () => new Date() }));
  const result = await denied();
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'DEPENDENCY_UNAVAILABLE');
  const stale = { async lookup(scope, query) {
    return { ...await authority.lookup(scope, query), observedAt: query.requestedAt - 1 };
  } };
  const staleSend = await harness(t, createSubmissionService(repo, stale, { clock: () => new Date() }));
  assert.equal((await staleSend()).body.error.code, 'DEPENDENCY_UNAVAILABLE');
});

test('maps approved conflicts and quota errors without leaking request content', async t => {
  let failure;
  const send = await harness(t, { async submit() { throw failure; } });
  for (const [code, status] of [['IDEMPOTENCY_KEY_REUSED', 409], ['GENERATION_IN_PROGRESS', 409], ['QUOTA_EXCEEDED', 429]]) {
    failure = new SubmissionError(code);
    const result = await send();
    assert.equal(result.status, status);
    assert.equal(result.body.error.code, code);
    assert.equal(result.body.error.retryable, false);
    assert.equal(result.headers.get('retry-after'), null);
  }
  failure = new Error(body.content);
  const result = await send();
  assert.equal(result.status, 500);
  assert.ok(!JSON.stringify(result.body).includes(body.content));
});
