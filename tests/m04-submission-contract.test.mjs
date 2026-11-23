// Isolated HTTP contract tests. The router uses a synthetic verification
// boundary and service port so malformed requests cannot reach persistence.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import express from 'express';
import { createApp } from '../apps/api/dist/app.js';
import { submissionRoutes } from '../apps/api/dist/submission/routes.js';
import { SubmissionError } from '../apps/api/dist/submission/contracts.js';
import { createSubmissionService } from '../apps/api/dist/submission/service.js';
import { suppressionScopeKey } from '../apps/api/dist/security/suppression-authority.js';
import { unavailableSuppressionAuthority } from '../apps/api/dist/security/suppression-unavailable.js';
import { SecurityError } from '../apps/api/dist/security/errors.js';

const principal = { localUserId: randomUUID(), accountStatus: 'ACTIVE', clerkInstanceId: 'synthetic',
  subjectKeys: [{ version: 1, digest: 'synthetic' }] };
const conversationId = randomUUID(), ideaId = randomUUID();
const body = { clientSubmissionId: randomUUID(), content: 'Synthetic submission' };
const headers = { Authorization: 'Bearer test.only.token', 'Idempotency-Key': 'fixture-key', 'Content-Type': 'application/json' };
const authority = { async lookup(scope, query) {
  return { verdict: 'CLEAR', scope: suppressionScopeKey(scope), nonce: query.nonce, observedAt: Date.now(),
    validUntil: Date.now() + 1000, integrity: 'VERIFIED', coverage: 'COMPLETE', authority: 'INDEPENDENT', epoch: 'synthetic' };
} };

async function harness(t, service, options) {
  const app = express();
  app.use('/api/v1', submissionRoutes(service,
    async req => options?.authenticate ? options.authenticate(req)
      : req.get('Authorization') === headers.Authorization ? principal : null, options));
  if (options?.readConversation) app.get('/api/v1/conversations/:conversationId/messages',
    (_request, response) => response.set('Cache-Control', 'no-store').json({ route: 'workspace' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return async ({ input = JSON.stringify(body), fields = headers, id = conversationId, method = 'POST', path = '/messages' } = {}) => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/v1/conversations/' + id + path,
      { method, headers: fields, ...(method === 'POST' ? { body: input } : {}) });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
}

test('submission rejections correlate without exposing the reason, identity, path, or content', async t => {
  const events = [];
  t.mock.method(console, 'info', value => events.push(JSON.parse(value)));
  let account = principal, found = true, active = true, capability = true, writes = 0;
  const repo = {
    async scope() { return found ? { id: conversationId, ideaId, status: active ? 'ACTIVE' : 'ARCHIVED',
      idea: { id: ideaId, status: 'ACTIVE', ownerId: principal.localUserId } } : null; },
    async accept() { writes++; return { messageId: randomUUID(), generationId: randomUUID() }; }
  };
  const decision = { purpose: 'founders-lens:local-generation:submit', subjectVersions: [1],
    epoch: 'synthetic', expiresAt: Date.now() + 60_000 };
  const service = createSubmissionService(repo, authority, { clock: () => new Date(),
    allowSubmission: (actor, id, content) => actor === principal && id === conversationId && content === body.content,
    executionAdmission: async () => capability ? decision : undefined });
  const send = await harness(t, service, { authenticate(req) {
    if (req.get('Authorization') !== headers.Authorization) return null;
    if (!account) throw new SecurityError('ACCOUNT_UNAVAILABLE', 'ACCOUNT_BINDING_MISSING');
    return account;
  } });
  async function denied(category, status, options) {
    const result = await send(options);
    assert.equal(result.status, status);
    const requestId = result.headers.get('x-request-id');
    assert.match(requestId, /^[a-f0-9-]{36}$/);
    assert.equal(result.body.error.requestId, requestId);
    assert.deepEqual(events.pop(), { event: 'submission_rejected', requestId,
      route: 'conversation.messages', operation: 'submit', status, category });
    assert.deepEqual(Object.keys(result.body.error).sort(), ['code', 'message', 'requestId', 'retryable']);
    if (status === 404) assert.equal(result.body.error.code, 'RESOURCE_NOT_FOUND');
    assert.equal(writes, 0);
  }
  await denied('UNAUTHENTICATED', 401, { fields: { ...headers, Authorization: 'Bearer other.fixture.token' } });
  account = undefined;
  await denied('ACCOUNT_BINDING_MISSING', 403);
  account = { ...principal, localUserId: randomUUID() };
  await denied('SYNTHETIC_SCOPE_MISMATCH', 404);
  account = principal;
  await denied('SYNTHETIC_SCOPE_MISMATCH', 404, { id: randomUUID() });
  await denied('SYNTHETIC_SCOPE_MISMATCH', 404, { input: JSON.stringify({ ...body, content: body.content + '\n' }) });
  capability = false;
  await denied('SUBMISSION_CAPABILITY_DENIED', 503);
  capability = true;
  found = false;
  await denied('CONVERSATION_NOT_FOUND_OR_NOT_OWNED', 404);
  found = true;
  active = false;
  await denied('CONVERSATION_INACTIVE', 404);
  active = true;
  assert.equal((await send()).status, 202);
  assert.equal(writes, 1);
  assert.deepEqual(events, []);
});

test('scoped generation transcript reads leave other conversations with the workspace router', async t => {
  const send = await harness(t, { async history() { return { route: 'generation' }; } },
    { readConversation: conversationId });
  assert.deepEqual((await send({ method: 'GET' })).body, { route: 'generation' });
  assert.deepEqual((await send({ method: 'GET', id: randomUUID() })).body, { route: 'workspace' });
});

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

test('admission withholds a committed acceptance after the suppression window expires', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  let durable = false;
  const repo = {
    async scope() { return { id: conversationId, ideaId, status: 'ACTIVE',
      idea: { id: ideaId, status: 'ACTIVE', ownerId: principal.localUserId } }; },
    async accept(_principal, _command, _clock, _policy, requireFresh) {
      requireFresh();
      durable = true;
      now += 1000;
      return { messageId: randomUUID(), generationId: randomUUID() };
    }
  };
  const service = createSubmissionService(repo, authority, { clock: () => new Date(now) });
  await assert.rejects(service.submit(principal, conversationId, 'fixture-key', body), { code: 'DEPENDENCY_UNAVAILABLE' });
  assert.equal(durable, true);
});

test('isolated recovery projects the original IDs and negotiates legacy transcript without downgrade', async t => {
  const ref = { messageId: randomUUID(), generationId: randomUUID() };
  let reads = 0;
  const repo = {
    async scope(_actor, id) {
      return id === conversationId ? { id, ideaId, status: 'ACTIVE', idea: { id: ideaId, status: 'ACTIVE', ownerId: principal.localUserId } } : null;
    },
    async correlate(_actor, _scope, id) { return id === body.clientSubmissionId ? ref : null; },
    async history(_actor, _scope, limit) { reads++; assert.equal(limit, 26); return []; },
    async accept() { assert.fail('A GET reached acceptance'); }
  };
  const get = await harness(t, createSubmissionService(repo, authority, { clock: () => new Date(), cursorSecret: Buffer.alloc(32, 17) }));
  const path = '/submissions/' + body.clientSubmissionId;
  const recovered = await get({ method: 'GET', path });
  const statusUrl = '/api/v1/generations/' + ref.generationId;
  assert.equal(recovered.status, 200);
  assert.deepEqual(recovered.body, { clientSubmissionId: body.clientSubmissionId, ...ref, statusUrl, eventsUrl: statusUrl + '/events' });
  for (const opts of [{ path, id: randomUUID() }, { path: '/submissions/' + randomUUID() }]) {
    const response = await get({ method: 'GET', ...opts });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'NOT_FOUND');
  }
  assert.equal((await get({ method: 'GET', path, fields: {} })).status, 401);
  assert.equal((await get({ method: 'GET', path: path + '?unexpected=true' })).status, 400);
  for (const suffix of ['', '?assistantResponseVersion=1']) {
    const response = await get({ method: 'GET', path: '/messages' + suffix });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { items: [], page: { nextCursor: null, hasMore: false } });
  }
  const unavailable = await get({ method: 'GET', path: '/messages?assistantResponseVersion=2' });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(unavailable.body.error, { code: 'PROJECTION_UNAVAILABLE',
    message: 'The workspace request could not be completed.', retryable: true, requestId: unavailable.body.error.requestId });
  assert.ok(unavailable.body.error.requestId);
  for (const query of ['limit=0', 'limit=101', 'assistantResponseVersion=3', 'assistantResponseVersion=',
    'assistantResponseVersion=1&assistantResponseVersion=2', 'cursor=invalid']) {
    const response = await get({ method: 'GET', path: '/messages?' + query });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  }
  assert.equal(reads, 2);
  const denied = await harness(t, createSubmissionService(repo, unavailableSuppressionAuthority(), { clock: () => new Date() }));
  for (const readPath of [path, '/messages']) {
    assert.equal((await denied({ method: 'GET', path: readPath })).body.error.code, 'DEPENDENCY_UNAVAILABLE');
  }
});

test('the public shell remains unready and exposes neither recovery read', async t => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  for (const [path, status] of [
    ['/health/ready', 503],
    ['/api/v1/conversations/' + conversationId + '/messages', 404],
    ['/api/v1/conversations/' + conversationId + '/submissions/' + body.clientSubmissionId, 404]
  ]) {
    const response = await fetch(origin + path, { headers });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(await response.text(), '');
  }
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
