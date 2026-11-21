// Loopback HTTP tests for the isolated generation router and security adapter.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';
import { generationRoutes } from '../apps/api/dist/generation/routes.js';
import { createGenerationService } from '../apps/api/dist/generation/service.js';
import { suppressionScopeKey } from '../apps/api/dist/security/suppression-authority.js';
import { SubmissionError } from '../apps/api/dist/submission/contracts.js';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const express = require('express');
const id = randomUUID(), conversationId = randomUUID(), triggerMessageId = randomUUID(), ideaId = randomUUID();
const principal = { localUserId: randomUUID(), clerkSubject: 'synthetic', clerkInstanceId: 'test',
  accountStatus: 'ACTIVE', subjectKeys: [{ version: 1, digest: 'a'.repeat(64) }] };
const dto = { id, conversationId, triggerMessageId, status: 'PENDING', selected: false, createdAt: new Date().toISOString() };

async function server(t, options = {}) {
  const repository = {
    scope: async () => options.foreign ? null : { id: conversationId, ideaId,
      idea: { id: ideaId, ownerId: principal.localUserId, status: 'ACTIVE' } },
    status: async () => dto,
    async command(_principal, _scope, command) {
      if (command.key === 'conflict-key') throw new SubmissionError('IDEMPOTENCY_KEY_REUSED');
      return { status: 202, body: { ...dto, status: command.kind === 'cancel' ? 'CANCEL_REQUESTED' : 'PENDING' } };
    }
  };
  const authority = { async lookup(scope, { nonce }) {
    if (options.denied && scope.kind === 'IDEA') return null;
    return { scope: suppressionScopeKey(scope), nonce, verdict: 'CLEAR', integrity: 'VERIFIED', coverage: 'COMPLETE',
      authority: 'INDEPENDENT', epoch: 'test', observedAt: Date.now(), validUntil: Date.now() + 1000 };
  } };
  const app = express();
  app.use('/api/v1', generationRoutes(createGenerationService(repository, authority), async () => principal));
  const listener = app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const base = 'http://127.0.0.1:' + listener.address().port + '/api/v1';
  return (path, init) => fetch(base + path, { ...init, headers: { Authorization: 'Bearer test.only.token', ...init?.headers } });
}

test('isolated status publishes the exact Generation shape and no-store', async t => {
  const request = await server(t);
  const response = await request('/generations/' + id);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), dto);
});

test('authentication, neutral owner scope and independent idea failure are enforced', async t => {
  const request = await server(t);
  assert.equal((await request('/generations/' + id, { headers: { Authorization: '' } })).status, 401);
  assert.equal((await request('/generations/invalid')).status, 400);
  assert.equal((await request('/generations/' + id + '?extra=1')).status, 400);
  const foreign = await server(t, { foreign: true });
  assert.equal((await foreign('/generations/' + id)).status, 404);
  const denied = await server(t, { denied: true });
  assert.equal((await denied('/generations/' + id)).status, 503);
});

test('cancel has no body and regeneration requires an exact body, key and Location', async t => {
  const request = await server(t);
  const cancel = '/generations/' + id + '/cancel';
  const regenerate = '/conversations/' + conversationId + '/regenerations';
  const headers = { 'Idempotency-Key': 'fixture-key' };
  assert.equal((await request(cancel, { method: 'POST' })).status, 400);
  assert.equal((await request(cancel, { method: 'POST', headers, body: '{}' })).status, 400);
  const accepted = await request(cancel, { method: 'POST', headers });
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { ...dto, status: 'CANCEL_REQUESTED' });
  const post = value => request(regenerate, { method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  assert.equal((await post({ triggerMessageId, extra: true })).status, 400);
  const regenerated = await post({ triggerMessageId });
  assert.equal(regenerated.status, 202);
  assert.equal(regenerated.headers.get('location'), '/api/v1/generations/' + id);
  assert.deepEqual(await regenerated.json(), dto);
  assert.equal((await request(cancel, { method: 'POST', headers: { 'Idempotency-Key': 'conflict-key' } })).status, 409);
});
