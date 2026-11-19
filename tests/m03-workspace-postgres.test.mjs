// Exercises the unmounted workspace slice through HTTP against isolated PostgreSQL fixtures.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import express from 'express';
import { connection, settings } from '../apps/api/scripts/database.mjs';
import { createDatabaseClient } from '../apps/api/dist/persistence/client.js';
import { suppressionScopeKey } from '../apps/api/dist/security/suppression-authority.js';
import { WorkspaceCursor } from '../apps/api/dist/workspace/contracts.js';
import { WorkspaceRepository } from '../apps/api/dist/workspace/repository.js';
import { WorkspaceService } from '../apps/api/dist/workspace/service.js';
import { workspaceRoutes } from '../apps/api/dist/workspace/routes.js';

test('workspace HTTP and PostgreSQL behavior', { skip: !process.argv.includes('--live'), timeout: 60_000 }, async t => {
  const values = await settings();
  const runtime = createDatabaseClient({ DATABASE_URL: values.TEST_DATABASE_URL });
  const owner = connection(values.TEST_MIGRATION_DATABASE_URL);
  await owner.connect();
  const fixtureIds = [randomUUID(), randomUUID()];
  const instanceId = 'ins_m03test_' + randomUUID();
  t.after(async () => {
    await runtime.$disconnect();
    try {
      await owner.query('BEGIN');
      const owners = 'SELECT id FROM "UserAccount" WHERE id=ANY($1::uuid[]) AND "clerkInstanceId"=$2';
      const parameters = [fixtureIds, instanceId];
      await owner.query('DELETE FROM "Conversation" WHERE "ideaId" IN (SELECT id FROM "Idea" WHERE "ownerId" IN (' + owners + '))', parameters);
      await owner.query('DELETE FROM "IdempotencyRecord" WHERE "accountId" IN (' + owners + ')', parameters);
      await owner.query('DELETE FROM "Idea" WHERE "ownerId" IN (' + owners + ')', parameters);
      await owner.query('DELETE FROM "UserAccount" WHERE id IN (' + owners + ')', parameters);
      await owner.query('COMMIT');
    } catch (error) { await owner.query('ROLLBACK'); throw error; }
    finally { await owner.end(); }
  });
  assert.deepEqual(await runtime.$queryRaw`SELECT current_database() AS db, current_user AS role`,
    [{ db: 'founders_lens_m02_test', role: 'fl_m02_runtime' }]);
  const principals = [];
  for (const id of fixtureIds) {
    const digest = randomBytes(32).toString('hex'), subject = 'user_m03test_' + id;
    await runtime.userAccount.create({ data: { id, clerkSubject: subject, clerkInstanceId: instanceId, subjectKey: digest } });
    principals.push({ localUserId: id, clerkInstanceId: instanceId, clerkSubject: subject, accountStatus: 'ACTIVE',
      subjectKeys: [{ version: 1, digest }], sessionId: 'sess_synthetic', requestId: randomUUID() });
  }
  let unavailable = false;
  let clearOnlyIdea;
  const authority = { async lookup(scope, query) {
    if (unavailable || (clearOnlyIdea && scope.kind === 'IDEA' && scope.ideaId !== clearOnlyIdea)) return null;
    return { verdict: 'CLEAR', scope: suppressionScopeKey(scope), nonce: query.nonce,
      observedAt: Date.now(), validUntil: Date.now() + 1000, integrity: 'VERIFIED', coverage: 'COMPLETE',
      authority: 'INDEPENDENT', epoch: 'synthetic-only' };
  } };
  const cursor = new WorkspaceCursor(randomBytes(32));
  const service = new WorkspaceService(new WorkspaceRepository(runtime), cursor, authority);
  const app = express();
  app.disable('etag');
  app.use((req, res, next) => {
    if (req.get('X-Test-Lose-Response') === 'yes') {
      // The handler invokes json only after the create transaction resolves.
      res.json = () => { res.destroy(); return res; };
    }
    next();
  });
  app.use('/api/v1', workspaceRoutes(service, async req => ({ 'Bearer alice': principals[0], 'Bearer bob': principals[1] })[req.get('Authorization')]));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  async function send(path, method = 'GET', body, headers = {}, actor = 'alice') {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/v1' + path, {
      method, headers: { Authorization: 'Bearer ' + actor, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  const key = { 'Idempotency-Key': 'synthetic-' + randomUUID() };
  const create = () => send('/ideas', 'POST', { title: 'Original', summary: 'Synthetic' }, key);
  const concurrent = await Promise.all(Array.from({ length: 8 }, create));
  const first = concurrent[0];
  assert.equal(first.status, 201);
  for (const result of concurrent) { assert.equal(result.status, 201); assert.deepEqual(result.body, first.body); }
  const ideaId = first.body.id, path = '/ideas/' + ideaId;
  assert.equal(first.headers.get('etag'), '"v1"');
  assert.equal(first.headers.get('location'), '/api/v1' + path);
  assert.deepEqual(Object.keys(first.body).sort(), ['createdAt', 'id', 'status', 'summary', 'title', 'updatedAt', 'version']);
  assert.equal(await runtime.idea.count({ where: { ownerId: fixtureIds[0] } }), 1);
  const conflict = await send('/ideas', 'POST', { title: 'Changed' }, key);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
  const renamed = await send(path, 'PATCH', { title: 'Renamed' }, { 'If-Match': '"v1"' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.headers.get('etag'), '"v2"');
  await t.test('replay needs clearance for the original idea only', async () => {
    clearOnlyIdea = ideaId;
    try {
      const replay = await create();
      assert.equal(replay.status, 201);
      assert.deepEqual(replay.body, first.body);
      const mismatch = await send('/ideas', 'POST', { title: 'Changed' }, key);
      assert.equal(mismatch.status, 409);
      clearOnlyIdea = randomUUID();
      assert.equal((await create()).status, 503, 'The original idea still needs fresh clearance');
    } finally {
      clearOnlyIdea = undefined;
    }
  });
  assert.equal((await send(path, 'PATCH', { title: 'Stale' }, { 'If-Match': '"v1"' })).status, 412);
  assert.equal((await send(path)).body.title, 'Renamed');
  const preferences = await send('/me/preferences', 'PATCH', { language: 'hinglish', researchEnabled: false }, { 'If-Match': '"v1"' });
  assert.equal(preferences.status, 200);
  assert.equal(preferences.headers.get('etag'), '"v2"');
  assert.deepEqual(preferences.body.preferences, { language: 'hinglish', researchEnabled: false });
  assert.equal((await send('/me/preferences', 'PATCH', {}, { 'If-Match': '"v1"' })).status, 412);

  const failingClient = runtime.$extends({ query: { idempotencyRecord: { async create() { throw new Error('Synthetic ledger failure'); } } } });
  const failing = new WorkspaceService(new WorkspaceRepository(failingClient), cursor, authority);
  await assert.rejects(failing.createIdea(principals[0], 'rollback-fixture', { title: 'Rollback' }));
  assert.equal(await runtime.idea.count({ where: { ownerId: fixtureIds[0] } }), 1);
  assert.equal(await runtime.idempotencyRecord.count({ where: { accountId: fixtureIds[0], key: 'rollback-fixture' } }), 0);

  const maxTitle = '🚀'.repeat(200);
  const secondKey = { 'Idempotency-Key': 'synthetic-second' };
  assert.equal((await send('/ideas', 'POST', { title: maxTitle + 'a' }, secondKey)).status, 400);
  const maxSummary = '\u{1F680}'.repeat(5000);
  const longerSummary = maxSummary + 'a';
  const secondBody = { title: maxTitle, summary: maxSummary };
  const rejectedSummary = await send('/ideas', 'POST', { ...secondBody, summary: longerSummary }, secondKey);
  assert.equal(rejectedSummary.status, 400);
  assert.equal(rejectedSummary.body.error.code, 'VALIDATION_ERROR');
  const second = await send('/ideas', 'POST', secondBody, secondKey);
  assert.equal(second.status, 201);
  const secondPath = '/ideas/' + second.body.id;
  assert.deepEqual((await send(secondPath)).body, second.body);
  assert.equal(second.body.title, maxTitle);
  assert.equal(second.body.summary, maxSummary);
  await t.test('summary persists unchanged and the receipt replays the original value', async () => {
    const match = { 'If-Match': '"v1"' };
    const invalid = await send(secondPath, 'PATCH', { summary: 'bad\0text' }, match);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');
    const patched = await send(secondPath, 'PATCH', { summary: longerSummary }, match);
    assert.equal(patched.status, 200);
    assert.equal((await send(secondPath)).body.summary, longerSummary);
    const replay = await send('/ideas', 'POST', secondBody, secondKey);
    assert.equal(replay.status, 201);
    assert.deepEqual(replay.body, second.body);
    const cleared = await send(secondPath, 'PATCH', { summary: null }, { 'If-Match': '"v2"' });
    assert.equal(cleared.status, 200);
    assert.equal((await send(secondPath)).body.summary, null);
  });
  const page = await send('/ideas?limit=1');
  assert.equal(page.body.items.length, 1);
  assert.equal(page.body.page.hasMore, true);
  const nextPath = '/ideas?limit=1&cursor=' + encodeURIComponent(page.body.page.nextCursor);
  const next = await send(nextPath);
  assert.equal(next.body.items.length, 1);
  assert.notEqual(next.body.items[0].id, page.body.items[0].id);
  assert.equal((await send(nextPath, 'GET', undefined, {}, 'bob')).status, 400);

  const children = path + '/conversations';
  assert.equal((await send(children, 'POST', { ownerId: fixtureIds[1] })).status, 400);
  assert.equal((await send(path)).status, 200, 'A separate conversation failure leaves the accepted idea intact');
  // Drop the actual HTTP response and reconcile with a GET.
  await assert.rejects(send(children, 'POST', { title: 'Lost reply' }, { 'X-Test-Lose-Response': 'yes' }), TypeError);
  const list = await send(children);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.items.map(item => item.title), ['Lost reply']);
  const conversation = await send(children, 'POST', { title: 'Explicit second create' });
  assert.equal(conversation.status, 201);
  const childPath = '/conversations/' + conversation.body.id;
  assert.equal((await send(childPath)).body.ideaId, ideaId);
  assert.ok(!Object.hasOwn(conversation.body, 'metadataVersion'));
  const childPage = await send(children + '?limit=1');
  assert.equal(childPage.body.page.hasMore, true);
  const childCursor = encodeURIComponent(childPage.body.page.nextCursor);
  assert.equal((await send(children + '?limit=1&cursor=' + childCursor)).body.items.length, 1);
  assert.equal((await send('/ideas/' + second.body.id + '/conversations?cursor=' + childCursor)).status, 400);
  assert.equal((await send('/ideas/' + second.body.id + '/conversations')).body.items.length, 0);

  const archived = await send(path, 'PATCH', { status: 'ARCHIVED' }, { 'If-Match': '"v2"' });
  assert.equal(archived.status, 200);
  assert.equal((await send(path)).body.status, 'ARCHIVED');
  assert.equal((await send(children)).body.items.length, 2);
  assert.equal((await send(childPath)).status, 200);
  assert.equal((await send(children, 'POST', {})).status, 404);
  assert.equal((await send(path, 'PATCH', { status: 'ACTIVE' }, { 'If-Match': '"v3"' })).status, 404);
  const foreign = await send(path, 'GET', undefined, {}, 'bob');
  const missing = await send('/ideas/' + randomUUID(), 'GET', undefined, {}, 'bob');
  assert.equal(foreign.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual({ ...foreign.body.error, requestId: undefined }, { ...missing.body.error, requestId: undefined });
  assert.equal((await send(childPath, 'GET', undefined, {}, 'bob')).status, 404);
  assert.equal((await send(path, 'GET', undefined, {}, 'unknown')).status, 401);
  unavailable = true;
  assert.equal((await send(path)).status, 503);
  assert.equal((await send(childPath)).status, 503);
  unavailable = false;
  await runtime.userAccount.update({ where: { id: fixtureIds[0] }, data: { status: 'DISABLED' } });
  assert.equal((await send(path)).status, 403);
  assert.equal((await send(childPath)).status, 403);
});
