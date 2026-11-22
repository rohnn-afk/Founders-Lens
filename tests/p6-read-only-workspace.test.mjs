// Pre-activation contracts. These fixtures do not establish an operational
// recovery gate and never mount the list router in normal startup.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { PrismaIdentityRepository } from '../apps/api/dist/security/identity-repository.js';
import { suppressionScopeKey } from '../apps/api/dist/security/suppression-authority.js';
import { WorkspaceCursor } from '../apps/api/dist/workspace/contracts.js';
import { workspaceIdeaListRoutes } from '../apps/api/dist/workspace/routes.js';
import { WorkspaceService } from '../apps/api/dist/workspace/service.js';
import { lockIdea } from '../apps/api/dist/workspace/repository.js';
import { localReadOnlyWorkspace } from '../apps/api/dist/workspace/read-only-composition.js';

test('local composition requires opt-in, rejects production and fails closed with incomplete configuration', async () => {
  assert.equal(await localReadOnlyWorkspace({}), undefined);
  assert.equal(await localReadOnlyWorkspace({ NODE_ENV: 'production', FL_P6_READ_ONLY: '1' }), undefined);
  await assert.rejects(localReadOnlyWorkspace({ FL_P6_READ_ONLY: '1' }), { code: 'DEPENDENCY_UNAVAILABLE' });
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
  for (const [method, path] of [['HEAD', '/ideas'], ['POST', '/ideas'], ['PATCH', '/ideas'],
    ['GET', '/ideas/' + randomUUID()], ['GET', '/conversations/' + randomUUID()]]) {
    assert.equal((await fetch(api + path, { method, headers })).status, 404);
  }
  assert.equal(calls, 1);
});
