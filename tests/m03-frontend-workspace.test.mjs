// Deterministic workspace controller tests. Synthetic DTOs exercise navigation,
// identity races, pagination and create recovery without a backend or browser.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function controller(name) {
  const source = await readFile(new URL('../apps/web/features/workspace/' + name + '.ts', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext } });
  return import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
}
const { createReadController, readThink, readConversation } = await controller('read-controller');
const { createCommandController } = await controller('create-controller');

const ok = data => ({ status: 200, data });
const created = data => ({ status: 201, data });
const page = (items, nextCursor = null) => ({ items, page: { hasMore: nextCursor !== null, nextCursor } });
const idea = (id, status = 'ACTIVE') => ({ id, title: 'Synthetic ' + id, status, version: 1,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
const chat = (id, ideaId) => ({ id, ideaId, title: 'Synthetic conversation', status: 'ACTIVE', proactiveResearch: false, version: 1 });
const api = overrides => ({
  ideas: async () => ok(page([])), idea: async id => ok(idea(id)),
  conversations: async () => ok(page([])), conversation: async id => ok(chat(id, 'first')),
  ...overrides
});

test('chooser caches only its current account and route cursor pages', async () => {
  const reads = createReadController();
  const calls = [];
  const source = api({ ideas: async cursor => {
    calls.push(cursor);
    return ok(cursor ? page([idea('last')]) : page([idea('first')], 'next-page'));
  } });
  const load = (scope, cursor) => reads.read(scope, ['ideas', cursor], signal => source.ideas(cursor, signal), true);
  const scope = reads.enter('founder-a');
  const first = await load(scope, null);
  assert.equal(first.data.page.nextCursor, 'next-page');
  assert.equal((await load(scope, 'next-page')).data.items[0].id, 'last');
  assert.deepEqual(await load(scope, null), first);
  assert.deepEqual(calls, [null, 'next-page']);
  await load(reads.enter('founder-a'), null);
  await load(reads.enter('founder-b'), null);
  assert.deepEqual(calls, [null, 'next-page', null, null]);
});

test('direct links and history re-entry verify both route IDs in a fresh scope', async () => {
  const reads = createReadController();
  const requested = [];
  const source = api({ idea: async id => { requested.push(id); return ok(idea(id)); } });
  const open = () => readConversation(reads, source, reads.enter('founder-a'), 'first', 'chat');
  assert.equal((await open()).data.conversation.id, 'chat');
  assert.equal((await readThink(reads, source, reads.enter('founder-a'), 'next', null)).data.idea.id, 'next');
  assert.equal((await open()).data.conversation.ideaId, 'first');
  assert.equal((await readConversation(createReadController(), source, reads.enter('founder-a'), 'first', 'chat')).kind, 'stale');
  const refreshed = createReadController();
  assert.equal((await readConversation(refreshed, source, refreshed.enter('founder-a'), 'first', 'chat')).kind, 'ready');
  assert.deepEqual(requested, ['first', 'next', 'first', 'first']);
});

test('sign-out, account swap, same-account session renewal and route changes reject late results', async () => {
  const founders = [{ id: 'founder-a', display: 'Same Name' }, { id: 'founder-b', display: 'Same Name' }];
  for (const transition of [[null, true], [founders[1].id, true], [founders[0].id, true], [founders[0].id, false]]) {
    const reads = createReadController();
    const scope = reads.enter(founders[0].id);
    const response = Promise.withResolvers();
    const late = reads.read(scope, ['ideas', null], () => response.promise);
    reads.enter(...transition);
    assert.equal(scope.signal.aborted, true);
    response.resolve(ok(page([idea('old-private-title')])));
    assert.deepEqual(await late, { kind: 'stale' });
  }
});

test('foreign, missing and wrong-parent links share a neutral result', async () => {
  const reads = createReadController();
  const scope = reads.enter('founder-a');
  for (const source of [
    api({ idea: async () => ({ status: 404 }), conversation: async () => assert.fail('Child read after parent denial') }),
    api({ conversation: async () => ({ status: 404 }) }),
    api({ conversation: async id => ok(chat(id, 'other-idea')) })
  ]) assert.deepEqual(await readConversation(reads, source, scope, 'first', 'chat'), { kind: 'missing' });
  assert.deepEqual(await readThink(reads, api({ conversations: async () => ok(page([chat('chat', 'other-idea')])) }),
    scope, 'first', null), { kind: 'missing' });
});

test('archived metadata remains readable and read failures carry no private DTO', async () => {
  const reads = createReadController();
  const scope = reads.enter('founder-a');
  const source = api({ idea: async id => ok(idea(id, 'ARCHIVED')) });
  assert.equal((await readThink(reads, source, scope, 'first', null)).data.idea.status, 'ARCHIVED');
  assert.equal((await readConversation(reads, source, scope, 'first', 'chat')).kind, 'ready');
  for (const [status, kind] of [[401, 'signed-out'], [403, 'blocked'], [429, 'error'], [503, 'error']]) {
    assert.deepEqual(await reads.read(scope, ['ideas'], async () => ({ status })), { kind });
  }
  assert.deepEqual(await reads.read(scope, ['ideas'], async () => ok(page([]))), { kind: 'ready', data: page([]) });
});

test('idea retry preserves the frozen body and key and is explicit', async () => {
  const reads = createReadController();
  const scope = reads.enter('founder-a');
  const calls = [];
  const commands = createCommandController(api({ createIdea: async (body, key) => {
    calls.push({ body, key });
    if (calls.length === 1) throw Error('Synthetic reply lost');
    return created(idea('new'));
  } }), reads.isCurrent, () => 'synthetic-key');
  const body = { title: 'Original' };
  assert.equal((await commands.submitIdea(scope, body)).kind, 'uncertain');
  body.title = 'Edited';
  assert.equal((await commands.submitIdea(scope, body)).kind, 'uncertain');
  assert.equal(calls.length, 1);
  assert.equal((await commands.submitIdea(scope)).kind, 'created');
  assert.deepEqual(calls.map(call => [call.body.title, call.key]), [['Original', 'synthetic-key'], ['Original', 'synthetic-key']]);
  assert.equal(Object.isFrozen(calls[0].body), true);
});

test('lost conversation reply reconciles with GET and never retries an unkeyed POST', async () => {
  const reads = createReadController();
  const scope = reads.enter('founder-a');
  let posts = 0;
  const source = api({ createConversation: async () => { posts++; throw Error('Synthetic reply lost'); } });
  const commands = createCommandController(source, reads.isCurrent);
  assert.equal((await commands.submitConversation(scope, 'first', {})).kind, 'uncertain');
  assert.equal((await readThink(reads, source, scope, 'first', null)).data.conversations.items.length, 0);
  const next = reads.enter('founder-a');
  assert.equal((await commands.submitConversation(next, 'first', {})).kind, 'uncertain');
  assert.equal(posts, 1);
});

test('clearing a signed-out session clears pending intent and rejects its late create', async () => {
  const reads = createReadController();
  const response = Promise.withResolvers();
  const source = api({ createIdea: () => response.promise });
  const commands = createCommandController(source, reads.isCurrent, () => 'synthetic-key');
  const pending = commands.submitIdea(reads.enter('founder-a'), { title: 'Original' });
  commands.clear();
  const next = reads.enter('founder-b', true);
  response.resolve(created(idea('old')));
  assert.equal((await pending).kind, 'stale');
  assert.equal((await commands.submitIdea(next)).kind, 'rejected');
});
