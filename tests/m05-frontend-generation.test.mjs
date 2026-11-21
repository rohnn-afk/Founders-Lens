// Deterministic generation use-case tests. A controlled clock distinguishes
// observation deadlines from authoritative server transitions.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../apps/web/features/workspace/generation-controller.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext }
});
const { createGenerationController } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
const dto = (status, id = 'attempt') => ({ id, conversationId: 'conversation', triggerMessageId: 'user',
  status, selected: false, createdAt: '2026-01-01T00:00:00Z' });
const reply = (status, id) => ({ status: 200, data: dto(status, id) });

function fixture(api) {
  let now = 0, sequence = 0, refreshes = 0, invalidations = 0;
  const updates = [], tasks = new Map(), abort = new AbortController();
  const scope = { account: 'account', sessionGeneration: 1, routeGeneration: 1, signal: abort.signal };
  const controller = createGenerationController(api, scope, 'conversation', () => !abort.signal.aborted,
    value => updates.push(value), () => refreshes++, () => invalidations++, {
      now: () => now, key: () => 'key-' + ++sequence,
      schedule(callback, delay) { tasks.set(++sequence, { callback, at: now + delay }); return sequence; },
      cancelTimer(id) { tasks.delete(id); }
    });
  return { controller, abort, updates, refreshes: () => refreshes, invalidations: () => invalidations,
    async advance(ms) {
      const goal = now + ms;
      for (;;) {
        const next = [...tasks].filter(([, task]) => task.at <= goal).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        tasks.delete(next[0]);
        next[1].callback();
        await tick();
      }
      now = goal;
    } };
}

test('single observer respects retry-after and refreshes on confirmed terminal status', async () => {
  let calls = 0;
  const pending = Promise.withResolvers();
  const f = fixture({ status() {
    calls++;
    return calls === 1 ? pending.promise : Promise.resolve(reply('COMPLETED'));
  } });
  f.controller.observe('attempt');
  f.controller.observe('attempt');
  await f.advance(500);
  assert.equal(calls, 1);
  pending.resolve({ status: 429, retryAfterMs: 4000 });
  await tick();
  await f.advance(3999);
  assert.equal(calls, 1);
  await f.advance(1);
  assert.equal(calls, 2);
  assert.equal(f.refreshes(), 1);
  assert.equal(f.updates.at(-1).value.status, 'COMPLETED');
});

test('bounded observation pauses without manufacturing failure and permits Check status', async () => {
  let calls = 0;
  const f = fixture({ async status() { calls++; return reply('RUNNING'); } });
  f.controller.observe('attempt');
  await tick();
  await f.advance(60_000);
  assert.equal(f.updates.at(-1).observation, 'paused');
  assert.equal(f.updates.at(-1).value.status, 'RUNNING');
  const before = calls;
  await f.advance(60_000);
  assert.equal(calls, before);
  f.controller.observe();
  assert.equal(calls, before + 1);
});

test('scope abort rejects a late status and removes scheduled work', async () => {
  const pending = Promise.withResolvers();
  let signal;
  const f = fixture({ status(_id, input) { signal = input; return pending.promise; } });
  f.controller.observe('attempt');
  f.abort.abort();
  assert.equal(signal.aborted, true);
  pending.resolve(reply('COMPLETED'));
  await tick();
  await f.advance(60_000);
  assert.equal(f.refreshes(), 0);
  assert.equal(f.updates.length, 1);
});

test('cancel retries the same key and completion wins the race', async () => {
  const calls = [];
  const f = fixture({ async status() { return reply('COMPLETED'); }, async cancel(id, key) {
    calls.push([id, key]);
    if (calls.length === 1) throw new Error('ambiguous transport');
    return reply('COMPLETED');
  } });
  f.controller.observe('attempt');
  await tick();
  await f.controller.cancel();
  assert.equal(f.updates.at(-1).command, 'unknown');
  await f.controller.retry();
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(f.updates.at(-1).value.status, 'COMPLETED');
});

for (const terminal of ['CANCELLED', 'COMPLETED']) {
  test('cancellation replay cannot replace confirmed ' + terminal + ' while GET is pending', async () => {
    const delayed = Promise.withResolvers();
    const posts = [];
    let reads = 0;
    const f = fixture({
      async status() {
        reads++;
        if (reads === 1) return reply('RUNNING');
        if (reads === 2) return reply(terminal);
        return delayed.promise;
      },
      async cancel(id, key) {
        posts.push([id, key]);
        if (posts.length === 1) throw new Error('Committed stop acknowledgement was lost');
        return { status: 202, data: dto('CANCEL_REQUESTED') };
      }
    });
    try {
      f.controller.observe('attempt');
      await tick();
      await f.controller.cancel();
      assert.equal(f.updates.at(-1).command, 'unknown');
      assert.equal(posts.length, 1);
      f.controller.observe();
      await tick();
      assert.equal(f.updates.at(-1).value.status, terminal);
      const refreshes = f.refreshes();
      await f.controller.retry();
      assert.equal(reads, 3);
      assert.equal(f.updates.at(-1).value.status, terminal);
      assert.equal(f.updates.at(-1).command, undefined);
      assert.equal(f.refreshes(), refreshes);
      assert.deepEqual(posts, [posts[0], posts[0]]);
    } finally {
      f.abort.abort();
      delayed.resolve(reply(terminal));
    }
  });
}

test('regeneration retains exact intent across ambiguity and observes the new attempt', async () => {
  const calls = [];
  const f = fixture({ async status(id) { return reply('FAILED', id); }, async regenerate(conversation, trigger, key) {
    calls.push([conversation, trigger, key]);
    if (calls.length === 1) return { status: 500 };
    return { status: 202, data: dto('PENDING', 'replacement') };
  } });
  await f.controller.regenerate('user');
  assert.equal(f.refreshes(), 0);
  await f.controller.regenerate('other-user');
  await f.controller.retry();
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls.length, 2);
  assert.equal(f.updates.at(-1).value.id, 'replacement');
  assert.equal(f.refreshes(), 1);
});

test('unavailable resources clear confirmed data and expired sessions invalidate scope', async () => {
  let calls = 0;
  const f = fixture({ async status() {
    return ++calls === 1 ? reply('RUNNING') : { status: calls === 2 ? 404 : 401 };
  } });
  f.controller.observe('attempt');
  await tick();
  await f.advance(1000);
  assert.deepEqual(f.updates.at(-1), { observation: 'blocked' });
  f.controller.observe();
  await tick();
  assert.equal(f.invalidations(), 1);
  assert.equal(f.updates.at(-1).value, undefined);
});

test('a rate-limited access recheck cannot reveal previously hidden history', async () => {
  let calls = 0;
  const f = fixture({ async status() {
    return ++calls === 1 ? { status: 404 } : { status: 429, retryAfterMs: 90_000 };
  } });
  f.controller.observe('attempt');
  await tick();
  f.controller.observe();
  await tick();
  assert.deepEqual(f.updates.at(-1), { observation: 'blocked' });
  assert.equal(f.refreshes(), 0);
});
