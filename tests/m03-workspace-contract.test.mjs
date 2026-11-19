// Checks workspace HTTP validation and cursor integrity without a database.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import express from 'express';
import { conversationCreate, ideaCreate, ideaDto, ideaPatch, input, output, WorkspaceCursor } from '../apps/api/dist/workspace/contracts.js';
import { workspaceRoutes } from '../apps/api/dist/workspace/routes.js';

test('cursor preserves its anchor and rejects tampering and scope changes', () => {
  const cursors = new WorkspaceCursor(randomBytes(32));
  const anchor = { id: randomUUID(), updatedAt: new Date() };
  const cursor = cursors.encode('founder-a/idea-a', anchor);
  assert.deepEqual(cursors.decode('founder-a/idea-a', cursor), anchor);
  for (const [scope, token] of [['founder-b/idea-a', cursor], ['founder-a/idea-b', cursor], ['founder-a/idea-a', cursor + 'x']]) {
    assert.throws(() => cursors.decode(scope, token), { code: 'VALIDATION_ERROR' });
  }
});

test('HTTP boundary rejects malformed requests before invoking the workspace service', async t => {
  let calls = 0;
  const service = new Proxy({}, { get() { return () => { calls++; throw new Error('Unexpected service use'); }; } });
  const app = express();
  app.use('/api/v1', workspaceRoutes(service, async req => req.get('Authorization') ? {} : null));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const id = randomUUID();
  for (const [method, path, status, headers, body] of [
    ['GET', '/ideas', 401, {}, undefined],
    ['GET', '/ideas?limit=101', 400, { Authorization: 'synthetic' }, undefined],
    ['GET', '/conversations/invalid', 400, { Authorization: 'synthetic' }, undefined],
    ['POST', '/ideas', 400, { Authorization: 'synthetic', 'Content-Type': 'application/json' }, '{}'],
    ['POST', '/ideas', 400, { Authorization: 'synthetic', 'Content-Type': 'application/json', 'Idempotency-Key': 'synthetic-key' }, '{"title":"Synthetic","ownerId":"foreign"}'],
    ['POST', '/ideas', 415, { Authorization: 'synthetic', 'Content-Type': 'text/plain', 'Idempotency-Key': 'synthetic-key' }, '{}'],
    ['PATCH', '/ideas/' + id, 428, { Authorization: 'synthetic' }, '{}'],
    ['PATCH', '/me/preferences', 400, { Authorization: 'synthetic', 'If-Match': 'W/"v1"' }, '{}']
  ]) {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/v1' + path, { method, headers, body });
    assert.equal(response.status, status, path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const payload = await response.json();
    assert.equal(payload.error.requestId, response.headers.get('x-request-id'));
    assert.ok(!JSON.stringify(payload).includes('foreign'));
  }
  assert.equal(calls, 0);
});

test('titles use Unicode code points and reject text PostgreSQL cannot store', () => {
  const title = '🚀'.repeat(200);
  const time = new Date().toISOString();
  const idea = { id: randomUUID(), title, status: 'ACTIVE', version: 1, createdAt: time, updatedAt: time };
  for (const schema of [ideaCreate, ideaPatch, conversationCreate]) {
    assert.equal(input(schema, { title }).title, title);
    for (const invalid of [title + 'a', 'bad\0title', '\uD800', '\uDC00']) {
      assert.throws(() => input(schema, { title: invalid }), { code: 'VALIDATION_ERROR' });
    }
  }
  assert.deepEqual(output(ideaDto, idea), idea);
  for (const invalid of [title + 'a', 'bad\0title', '\uD800', '\uDC00']) {
    assert.throws(() => output(ideaDto, { ...idea, title: invalid }), { code: 'PROJECTION_UNAVAILABLE' });
  }
});

test('summary validation limits only creation and rejects storage-unsafe input', () => {
  const atLimit = '\u{1F680}'.repeat(5000);
  const overLimit = atLimit + 'a';
  assert.equal(input(ideaCreate, { title: 'Synthetic', summary: atLimit }).summary, atLimit);
  assert.throws(() => input(ideaCreate, { title: 'Synthetic', summary: overLimit }), { status: 400, code: 'VALIDATION_ERROR' });
  assert.throws(() => input(ideaCreate, { title: 'Synthetic', summary: null }), { status: 400, code: 'VALIDATION_ERROR' });
  for (const summary of ['bad\0text', '\uD800', '\uDC00']) {
    assert.throws(() => input(ideaCreate, { title: 'Synthetic', summary }), { status: 400, code: 'VALIDATION_ERROR' });
    assert.throws(() => input(ideaPatch, { summary }), { status: 400, code: 'VALIDATION_ERROR' });
  }
  assert.deepEqual(input(ideaPatch, { summary: null }), { summary: null });
  assert.deepEqual(input(ideaPatch, {}), {});
  assert.equal(input(ideaPatch, { summary: overLimit }).summary, overLimit);
  const time = new Date().toISOString();
  const idea = { id: randomUUID(), title: 'Synthetic', summary: overLimit, status: 'ACTIVE',
    version: 1, createdAt: time, updatedAt: time };
  assert.deepEqual(output(ideaDto, idea), idea);
});

test('conditional idea GET preserves the authorized 200 DTO and version ETag', async t => {
  const dto = { id: randomUUID(), version: 1, title: 'Synthetic' };
  const app = express();
  app.use('/api/v1', workspaceRoutes({ async idea() { return dto; } },
    async req => req.get('Authorization') ? {} : null));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port + '/api/v1/ideas/' + dto.id;
  const response = await fetch(url, { headers: {
    Authorization: 'synthetic', 'If-None-Match': '"v1"', 'Cache-Control': 'max-age=0'
  } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('etag'), '"v1"');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), dto);
});
