// Pre-activation contracts. These fixtures do not establish an operational
// recovery gate and never mount the list router in normal startup.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { PrismaIdentityRepository } from '../apps/api/dist/security/identity-repository.js';
import { suppressionScopeKey } from '../apps/api/dist/security/suppression-authority.js';
import { WorkspaceCursor } from '../apps/api/dist/workspace/contracts.js';
import { localConversationRoutes, workspaceIdeaListRoutes } from '../apps/api/dist/workspace/routes.js';
import { WorkspaceService } from '../apps/api/dist/workspace/service.js';
import { lockIdea } from '../apps/api/dist/workspace/repository.js';
import { localReadOnlyWorkspace, workspaceIdeasCors } from '../apps/api/dist/workspace/read-only-composition.js';

test('local composition requires opt-in, rejects production and fails closed with incomplete configuration', async () => {
  assert.equal(await localReadOnlyWorkspace({}), undefined);
  assert.equal(await localReadOnlyWorkspace({ NODE_ENV: 'production', FL_P6_READ_ONLY: '1' }), undefined);
  await assert.rejects(localReadOnlyWorkspace({ FL_P6_READ_ONLY: '1' }), { code: 'DEPENDENCY_UNAVAILABLE' });
});

test('P8 exposes conversation reads and approved POSTs without exposing generation admission', async t => {
  const ideaId = randomUUID(), conversationId = randomUUID(), submission = randomUUID();
  const app = express();
  let writes = 0;
  app.use('/api/v1', workspaceIdeasCors(false, { create: true, save: true }), localConversationRoutes({
    idea: async () => ({ id: ideaId }), conversations: async () => ({ items: [] }),
    conversation: async () => ({ id: conversationId, ideaId }), history: async () => ({ items: [] }),
    create: async () => { writes++; return { id: conversationId }; },
    save: async (_, id, key, body) => {
      assert.equal(id, conversationId);
      assert.equal(key, 'fixture-key');
      assert.deepEqual(body, { content: 'Test', clientSubmissionId: submission });
      writes++;
      return { role: 'USER' };
    }
  }, async req => req.get('authorization') === 'Bearer fixture' ? principal : null));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/v1';
  const collection = '/ideas/' + ideaId + '/conversations';
  const transcript = '/conversations/' + conversationId + '/messages';
  const origin = 'http://127.0.0.1:3000';
  const headers = { Authorization: 'Bearer fixture', Origin: origin };
  const request = (path, method = 'GET', extra = {}, body) => fetch(endpoint + path,
    { method, headers: { ...headers, ...extra }, ...(body && { body: JSON.stringify(body) }) });
  const listing = await request(collection);
  assert.equal(listing.status, 200);
  assert.equal(listing.headers.get('X-Workspace-Conversation-Creation'), 'enabled');
  assert.equal((await request('/conversations/' + conversationId)).headers.get('X-Workspace-Message-Save'), 'enabled');
  const unauthorized = await request(collection, 'GET', { Authorization: 'Bearer missing' });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get('X-Workspace-Conversation-Creation'), null);
  assert.equal((await request(transcript)).status, 200);
  assert.equal(writes, 0);
  assert.equal((await request(transcript, 'POST', { 'Content-Type': 'application/json' }, {})).status, 404);
  assert.equal((await request(transcript, 'HEAD')).status, 404);
  assert.equal((await request(transcript, 'GET', { Origin: 'http://localhost:3000' })).status, 403);
  assert.equal((await request(transcript + '/save', 'OPTIONS', { 'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'authorization,content-type,idempotency-key' })).status, 204);
  assert.equal((await request(collection, 'POST', { 'Content-Type': 'application/json' }, {})).status, 201);
  const body = { content: 'Test', clientSubmissionId: submission };
  assert.equal((await request(transcript + '/save', 'POST', { 'Content-Type': 'application/json' }, body)).status, 400);
  const saved = await request(transcript + '/save', 'POST', { 'Content-Type': 'application/json', 'Idempotency-Key': 'fixture-key' }, body);
  assert.equal(saved.status, 201);
  assert.equal(saved.headers.get('cache-control'), 'no-store');
  assert.equal(writes, 2);
});

const identity = { subject: 'user_fixture', instanceId: 'ins_fixture', sessionId: 'sess_fixture', expiresAt: Infinity };
const keys = [{ version: 1, digest: 'a'.repeat(64) }, { version: 2, digest: 'b'.repeat(64) }];
const accountId = randomUUID();
const principal = { localUserId: accountId, clerkInstanceId: identity.instanceId,
  clerkSubject: identity.subject, sessionId: identity.sessionId, subjectKeys: keys, accountStatus: 'ACTIVE' };

test('lookup-only resolution accepts a retained binding and never creates or rekeys accounts', async () => {
  const old = { id: accountId, status: 'ACTIVE', clerkInstanceId: identity.instanceId,
    subjectKeyVersion: 1, subjectKey: keys[0].digest };
  let account = old;
  let tombstone = null;
  let deletion = null;
  const forbiddenWrite = () => assert.fail('Read-only identity resolution attempted a write');
  const tx = {
    $queryRaw: async () => [],
    identityTombstone: { findFirst: async ({ where }) => {
      assert.deepEqual(where.OR.map(key => key.subjectKeyVersion), [1, 2]);
      return tombstone;
    } },
    dataOperation: { findFirst: async () => deletion },
    userAccount: { findUnique: async () => account, create: forbiddenWrite, update: forbiddenWrite }
  };
  const repository = new PrismaIdentityRepository({ $transaction: async work => work(tx) });
  assert.deepEqual(await repository.resolveExisting(identity, keys, 2), { id: accountId, status: 'ACTIVE' });
  for (const unavailable of [null, { ...old, status: 'DISABLED' }, { ...old, clerkInstanceId: 'ins_foreign' }]) {
    account = unavailable;
    await assert.rejects(repository.resolveExisting(identity, keys, 2), { code: 'ACCOUNT_UNAVAILABLE' });
  }
  account = { ...old, subjectKey: 'unmatched' };
  await assert.rejects(repository.resolveExisting(identity, keys, 2), { code: 'DEPENDENCY_UNAVAILABLE' });
  account = old;
  tombstone = { id: randomUUID() };
  await assert.rejects(repository.resolveExisting(identity, keys, 2), { code: 'ACCOUNT_UNAVAILABLE' });
  tombstone = null;
  deletion = { id: randomUUID() };
  await assert.rejects(repository.resolveExisting(identity, keys, 2), { code: 'ACCOUNT_UNAVAILABLE' });
});

test('idea listing denies evidence that expires during locks, transaction return or response verification', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const candidate = { id: randomUUID(), status: 'ACTIVE',
    title: 'Synthetic', version: 1, updatedAt: new Date(1000), createdAt: new Date(1000) };
  const authority = { async lookup(scope, request) {
    return { verdict: 'CLEAR', scope: suppressionScopeKey(scope), nonce: request.nonce,
      observedAt: now, validUntil: now + 100, integrity: 'VERIFIED', coverage: 'COMPLETE',
      authority: 'INDEPENDENT', epoch: 'fixture' };
  } };
  let expiryBoundary = 'none';
  const repository = {
    ideaPageMetadata: async () => [{ ...candidate, ownerId: accountId }],
    async transaction(_principal, action) {
      if (expiryBoundary === 'account lock') now += 100;
      const page = await action({ idea: async (_principal, _id, _access, beforeProjection) => {
        if (expiryBoundary === 'idea lock') now += 100;
        beforeProjection();
        return candidate;
      } });
      if (expiryBoundary === 'transaction return') now += 100;
      return page;
    }
  };
  const service = new WorkspaceService(repository, new WorkspaceCursor(randomBytes(32)), authority);
  assert.equal((await service.ideas(principal, {})).items[0].id, candidate.id);
  for (const boundary of ['account lock', 'idea lock', 'transaction return']) {
    expiryBoundary = boundary;
    await assert.rejects(service.ideas(principal, {}), { code: 'DEPENDENCY_UNAVAILABLE' });
  }
  expiryBoundary = 'none';
  await assert.rejects(service.ideas(principal, {}, async () => { now += 100; }), { code: 'DEPENDENCY_UNAVAILABLE' });
});

test('P7 denies suppressed, expired and blocked creation before inserting a row', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  let scenario = 'account suppression';
  let transaction = 0;
  const authority = { async lookup(scope, request) {
    const suppressed = scenario === 'account suppression' && scope.kind === 'ACCOUNT' ||
      scenario === 'idea suppression' && scope.kind === 'IDEA';
    return { verdict: suppressed ? 'SUPPRESSED' : 'CLEAR', scope: suppressionScopeKey(scope), nonce: request.nonce,
      observedAt: now, validUntil: now + 100, integrity: 'VERIFIED', coverage: 'COMPLETE', authority: 'INDEPENDENT', epoch: 'fixture' };
  } };
  const repo = { async transaction(_principal, action) {
    transaction++;
    if (transaction === 2 && (scenario === 'authority lock expiry' || scenario === 'decision lock expiry')) {
      now += scenario === 'decision lock expiry' ? 50 : 100;
    }
    return action({ ledger: async () => null, createIdea: () => assert.fail('Denied create reached the write') });
  } };
  const service = new WorkspaceService(repo, new WorkspaceCursor(randomBytes(32)), authority);
  for (const expected of ['account suppression', 'idea suppression', 'authority lock expiry', 'decision lock expiry']) {
    scenario = expected;
    transaction = 0;
    await assert.rejects(service.createIdea(principal, 'fixture-key', { title: 'Synthetic' }, async () =>
      now + (scenario === 'decision lock expiry' ? 50 : 500)), { code: 'DEPENDENCY_UNAVAILABLE' });
  }
});

test('P7 ideas composition restricts POST and preflights to the enabled local slice', async t => {
  for (const enabled of [false, true]) {
    const app = express();
    const created = { id: randomUUID(), version: 1 };
    app.use('/api/v1', workspaceIdeasCors(enabled), workspaceIdeaListRoutes({ ideas: async () => ({ items: [] }) },
      async req => req.get('authorization') === 'Bearer fixture' ? principal : null,
      enabled ? { createIdea: async (caller, key, body) => {
        assert.equal(caller.localUserId, accountId);
        assert.equal(key, 'fixture-key');
        assert.deepEqual(body, { title: 'Synthetic' });
        return created;
      } } : undefined));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = 'http://127.0.0.1:' + server.address().port + '/api/v1/ideas';
    const origin = 'http://127.0.0.1:3000';
    const preflight = (caller, headers) => fetch(url, { method: 'OPTIONS', headers: { Origin: caller,
      'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': headers } });
    const allowed = 'content-type,idempotency-key,authorization';
    assert.equal((await preflight(origin, allowed)).status, enabled ? 204 : 404);
    assert.equal((await preflight(origin, allowed + ',x-extra')).status, 404);
    assert.equal((await preflight('http://localhost:3000', allowed)).status, 403);
    const send = (body, headers = {}) => fetch(url, { method: 'POST', body: JSON.stringify(body), headers: {
      Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': 'fixture-key', ...headers } });
    assert.equal((await send({ title: 'Synthetic' })).status, enabled ? 401 : 404);
    const response = await send({ title: 'Synthetic' }, { Authorization: 'Bearer fixture' });
    assert.equal(response.status, enabled ? 201 : 404);
    if (enabled) {
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('location'), '/api/v1/ideas/' + created.id);
      assert.equal((await send({ title: 'Synthetic', ownerId: accountId }, { Authorization: 'Bearer fixture' })).status, 400);
    }
    assert.equal((await fetch(url + '/' + created.id)).status, 404);
    assert.equal((await fetch(url, { method: 'DELETE' })).status, 404);
  }
});

test('local idea deletion blocks founder field selection even while the row is active', async () => {
  const order = [];
  const ideaId = randomUUID();
  const tx = {
    $queryRaw: async () => { order.push('lock'); },
    dataOperation: { findFirst: async ({ where }) => {
      order.push('deletion');
      assert.deepEqual(where, { kind: 'DELETE_IDEA', ideaId });
      return { id: randomUUID() };
    } },
    idea: { findFirst: () => assert.fail('Suppressed founder fields were selected') }
  };
  await assert.rejects(lockIdea(tx, principal, ideaId, 'read'), { code: 'RESOURCE_NOT_FOUND' });
  assert.deepEqual(order, ['lock', 'deletion']);
});

test('isolated list boundary keeps authorized empty distinct from unavailable and exposes no deeper routes', async t => {
  let calls = 0;
  const empty = { items: [], page: { hasMore: false, nextCursor: null } };
  const app = express();
  app.use('/api/v1', workspaceIdeaListRoutes({ ideas: async () => { calls++; return empty; } },
    async req => req.get('authorization') === 'Bearer fixture' ? principal : null));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const api = 'http://127.0.0.1:' + server.address().port + '/api/v1';
  const headers = { Authorization: 'Bearer fixture' };
  const authorized = await fetch(api + '/ideas', { headers });
  assert.equal(authorized.status, 200);
  assert.equal(authorized.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await authorized.json(), empty);
  assert.equal((await fetch(api + '/ideas')).status, 401);
  const withBody = await new Promise((resolve, reject) => {
    const request = httpRequest(api + '/ideas', { headers: { ...headers, 'Content-Length': '2' } }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end('{}');
  });
  assert.equal(withBody, 400);
  for (const [method, path] of [['HEAD', '/ideas'], ['POST', '/ideas'], ['PATCH', '/ideas'],
    ['GET', '/ideas/' + randomUUID()], ['GET', '/conversations/' + randomUUID()]]) {
    assert.equal((await fetch(api + path, { method, headers })).status, 404);
  }
  assert.equal(calls, 1);
});
