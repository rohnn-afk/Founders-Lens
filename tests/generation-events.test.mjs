import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import express from 'express';
import { generationRoutes } from '../apps/api/dist/generation/routes.js';
import { SecurityError } from '../apps/api/dist/security/errors.js';
import { waitForTerminalEvent } from '../apps/web/features/workspace/generation-events.ts';

const id = '00000000-0000-4000-8000-000000000001';
const output = '00000000-0000-4000-8000-000000000002';
const headers = { Accept: 'text/event-stream', Authorization: 'Bearer fixture.owner.session' };

async function setup(t) {
  const state = { reads: 0, active: true, status: 'PENDING' };
  const app = express();
  app.use(generationRoutes({ async status(principal, target) {
    state.reads++;
    if (principal.localUserId !== 'owner' || target !== id) throw new SecurityError('RESOURCE_NOT_FOUND');
    return { id, status: state.status, outputMessageId: output, selected: true };
  } }, async req => {
    const auth = req.get('Authorization');
    if (!state.active || !auth) return null;
    return { localUserId: auth === headers.Authorization ? 'owner' : 'foreign', sessionId: 'fixture-session' };
  }, { events: true, statusOnly: true }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const request = (custom = headers) => fetch('http://127.0.0.1:' + server.address().port + '/generations/' + id + '/events',
    { headers: custom, signal: AbortSignal.timeout(8_000) });
  return { state, request };
}

test('SSE reauthorizes and emits ordered durable states, including terminal reconnect', async t => {
  const { request, state } = await setup(t);
  assert.equal((await request({ Accept: 'text/event-stream' })).status, 401);
  assert.equal((await request({ ...headers, Authorization: 'Bearer fixture.foreign.session' })).status, 404);
  assert.equal((await request({ ...headers, Accept: 'application/json' })).status, 406);
  assert.equal((await request({ ...headers, 'Last-Event-ID': '2' })).status, 400);
  const response = await request();
  assert.equal(response.headers.get('cache-control'), 'no-store, no-transform');
  state.status = 'RUNNING';
  await delay(2_100);
  state.status = 'COMPLETED';
  const stream = await response.text();
  assert.deepEqual([...stream.matchAll(/"status":"([^"]+)"/g)].map(match => match[1]), ['PENDING', 'RUNNING', 'COMPLETED']);
  const reconnect = await request();
  assert.match(await reconnect.text(), /^event: generation\.completed\ndata: .*"outputMessageId":/);
});

test('socket close stops checks and a revoked session receives no terminal data', async t => {
  const { request, state } = await setup(t);
  const disconnected = await request();
  await disconnected.body.cancel();
  const revoked = await request();
  const reads = state.reads;
  state.active = false;
  state.status = 'COMPLETED';
  const frames = await revoked.text();
  assert.match(frames, /event: stream\.error/);
  assert.doesNotMatch(frames, /generation\.completed|outputMessageId/);
  assert.equal(state.reads, reads);
});

test('stream quota limits concurrent attachments per account', async t => {
  const { request } = await setup(t);
  const active = await Promise.all(Array.from({ length: 4 }, () => request()));
  try {
    assert.ok(active.every(response => response.status === 200));
    assert.equal((await request()).status, 429);
  } finally { await Promise.all(active.map(response => response.body.cancel())); }
});

test('browser SSE parser handles fragmented frames and ignores foreign or stale observations', async () => {
  const text = ': heartbeat\n\nevent: generation.completed\ndata: ' +
    JSON.stringify({ schemaVersion: 1, generationId: id, status: 'COMPLETED' }) + '\n\n';
  const bytes = new TextEncoder().encode(text);
  const make = () => new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
  assert.equal(await waitForTerminalEvent(make(), output), false);
  assert.equal(await waitForTerminalEvent(make(), id), true);
});
