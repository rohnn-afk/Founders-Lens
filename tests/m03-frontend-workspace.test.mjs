// Deterministic workspace controller tests. Synthetic DTOs exercise navigation,
// identity races, pagination and create recovery without a backend or browser.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function controller(name) {
  const source = await readFile(new URL('../apps/web/features/workspace/' + name + '.ts', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext } });
  let moduleText = outputText;
  if (name === 'local-conversation-api') {
    const endpoints = await readFile(new URL('../apps/web/features/workspace/endpoints.ts', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(endpoints, { compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext } });
    moduleText = moduleText.replace("'./endpoints'", JSON.stringify('data:text/javascript;base64,' + Buffer.from(compiled.outputText).toString('base64')));
  }
  return import('data:text/javascript;base64,' + Buffer.from(moduleText).toString('base64'));
}
const { createReadController, readThink, readConversation } = await controller('read-controller');
const { createCommandController } = await controller('create-controller');
const { createLocalConversationApi } = await controller('local-conversation-api');
const { createMessageController } = await controller('message-controller');

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

test('owned ideas transport distinguishes empty, unauthorized, unavailable and malformed pages', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: 'http://127.0.0.1:3000' } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; });
  const headers = { 'X-Workspace-Conversations': 'enabled', 'X-Workspace-Idea-Creation': 'enabled', 'X-Workspace-Idea-Editing': 'enabled' };
  const responses = [
    Response.json(page([]), { headers }),
    new Response(null, { status: 401, headers }),
    new Response(null, { status: 403, headers }),
    new Response(null, { status: 503, headers }),
    Response.json(page([{ id: 'bad', title: 'Malformed', status: 'ACTIVE' }]), { headers }),
    new TypeError('Fixture network failure'),
    Response.json(page([idea('archived', 'ARCHIVED')]), { headers })
  ];
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:3001/api/v1/ideas?cursor=a%2Bb');
    assert.equal(options.headers.Authorization, 'Bearer fixture-token');
    assert.equal(options.cache, 'no-store');
    const result = responses.shift();
    if (result instanceof Error) throw result;
    return result;
  });
  const signal = new AbortController().signal;
  const client = createLocalConversationApi(async () => 'fixture-token');
  assert.deepEqual(await client.listOwnedIdeas('a+b', signal), {
    reply: ok(page([])), canCreate: true, canEdit: true, conversations: true
  });
  for (const status of [401, 403, 503]) {
    assert.deepEqual(await client.listOwnedIdeas('a+b', signal), {
      reply: { status }, canCreate: false, canEdit: false, conversations: false
    });
  }
  await assert.rejects(client.listOwnedIdeas('a+b', signal), /Invalid workspace page/);
  await assert.rejects(client.listOwnedIdeas('a+b', signal), /Fixture network failure/);
  assert.equal(fetch.mock.callCount(), 6, 'Reads wait for an explicit retry after a transport failure');
  assert.deepEqual((await client.listOwnedIdeas('a+b', signal)).reply, ok(page([idea('archived', 'ARCHIVED')])));
  const expired = createLocalConversationApi(async () => null);
  assert.equal((await expired.listOwnedIdeas(null, signal)).reply.status, 401);
  assert.equal(fetch.mock.callCount(), 7);
});

test('idea editor sends the original version and surfaces a stale write without retrying', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: 'http://127.0.0.1:3000' } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; });
  const patch = { title: 'Revised idea', summary: null };
  const updated = { ...idea('idea-id'), ...patch, version: 3 };
  const responses = [new Response(null, { status: 412 }), Response.json(updated)];
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:3001/api/v1/ideas/idea-id');
    assert.equal(options.method, 'PATCH');
    assert.equal(options.headers['If-Match'], '"v2"');
    assert.equal(options.headers.Authorization, 'Bearer fixture-token');
    assert.deepEqual(JSON.parse(options.body), patch);
    return responses.shift();
  });
  const client = createLocalConversationApi(async () => 'fixture-token');
  const signal = new AbortController().signal;
  assert.deepEqual(await client.editIdea('idea-id', 2, patch, signal), { status: 412 });
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(await client.editIdea('idea-id', 2, patch, signal), ok(updated));
});

test('generation capability distinguishes save-only access from a failed read', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: 'http://127.0.0.1:3000' } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; });
  const headers = { 'X-Workspace-Generation': 'enabled' };
  const responses = [
    Response.json(chat('current', 'idea'), { headers }),
    Response.json(chat('current', 'idea'), { headers: { 'X-Workspace-Message-Save': 'enabled' } }),
    new Response(null, { status: 503, headers }),
    new Response(null, { status: 404 }),
    Response.json(chat('wrong', 'idea'), { headers })
  ];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:3001/api/v1/conversations/current');
    assert.equal(options.method, 'GET');
    return responses.shift();
  });
  const client = createLocalConversationApi(async () => 'fixture-token');
  const probe = () => client.conversationPermissions('current', new AbortController().signal);
  for (const expected of [{ generation: true, save: false }, { generation: false, save: true }, null, null]) {
    assert.deepEqual(await probe(), expected);
  }
  await assert.rejects(probe, /Invalid workspace response/);
});

test('browser submit carries a safe API request ID only for the current session and route', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: 'http://127.0.0.1:3000' } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; });
  const requestId = '057c8ea3-e1d3-47cf-b63f-3372690d4148';
  let header = requestId;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:3001/api/v1/conversations/current/messages');
    assert.equal(JSON.parse(init.body).content, 'Exact synthetic bytes');
    return Response.json({ error: { code: 'RESOURCE_NOT_FOUND' } }, {
      status: 404, headers: { 'X-Request-Id': header }
    });
  });
  const { messageApi } = createLocalConversationApi(async () => 'fixture-token');
  const lifetime = new AbortController();
  const scope = { account: 'test', sessionGeneration: 1, routeGeneration: 1, signal: lifetime.signal };
  const storage = { read: () => ({}), save: (_target, _id, key) => ({ key }), remove() {} };
  const composer = createMessageController(messageApi, storage, scope, 'idea', 'current',
    () => !lifetime.signal.aborted, () => {});
  assert.equal(await composer.send('Exact synthetic bytes'), 'rejected');
  assert.equal(composer.failureRequestId(), requestId);
  header = 'Rejected unsafe header';
  assert.equal(await composer.send('Exact synthetic bytes'), 'rejected');
  assert.equal(composer.failureRequestId(), undefined);
  header = requestId;
  assert.equal(await composer.send('Exact synthetic bytes'), 'rejected');
  lifetime.abort();
  assert.equal(composer.failureRequestId(), undefined);
});

test('Harbor Cart and ordinary whitespace reach the submission JSON unchanged', async t => {
  // This fixture is test-only. The production composer continues to send its draft as entered.
  const prompt = 'Fictional startup Harbor Cart plans to deliver reusable grocery crates to small neighborhood shops. We assume shop owners will pay monthly for fewer packaging problems. What is the riskiest assumption, and how could we test it cheaply?';
  const approved = '9b05e9e197efabef646a85842aa7ddc83ba2cab78eab3efa9a40e75b9040095a';
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: 'http://127.0.0.1:3000' } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; });
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:3001/api/v1/conversations/harbor-fixture/messages');
    assert.equal(init.method, 'POST');
    assert.match(init.headers['Idempotency-Key'], /^[a-f0-9-]{36}$/);
    bodies.push(JSON.parse(init.body));
    return Response.json({ error: { code: 'RESOURCE_NOT_FOUND' } }, { status: 404 });
  });
  const { messageApi } = createLocalConversationApi(async () => 'fixture-token');
  const scope = { account: 'fixture', sessionGeneration: 1, routeGeneration: 1, signal: new AbortController().signal };
  const storage = { read: () => ({}), save: (_target, _id, key) => ({ key }), remove() {} };
  const composer = createMessageController(messageApi, storage, scope, 'idea', 'harbor-fixture', () => true, () => {});
  const drafts = [prompt, prompt + '\n', '  ordinary\n\nmessage\t '];
  for (const draft of drafts) assert.equal(await composer.send(draft), 'rejected');
  assert.deepEqual(bodies.map(body => body.content), drafts);
  assert.equal(new Set(bodies.map(body => body.clientSubmissionId)).size, drafts.length);
  const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
  assert.equal(hash(bodies[0].content), approved);
  assert.notEqual(hash(bodies[1].content), approved);
});

test('P8 save retains the exact intent after a lost response and discards it on session cleanup', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: 'http://127.0.0.1:3000' } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, body: init.body, key: init.headers['Idempotency-Key'] });
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    if (calls.length === 1) throw new Error('Lost reply');
    if (calls.length === 2) return new Response(null, { status: 404 });
    return Response.json({ id: 'saved', conversationId: 'conversation', sequence: 1,
      role: 'USER', content: 'Original', createdAt: '2026-01-01T00:00:00.000Z' }, { status: 201 });
  });
  let sequence = 0;
  const { savedMessages } = createLocalConversationApi(async () => 'fixture-token', () => `fixture-${++sequence}`);
  const signal = new AbortController().signal;
  assert.equal((await savedMessages.save('conversation', 'Original', signal)).status, 503);
  assert.equal(savedMessages.pending('conversation'), 'Original');
  assert.equal((await savedMessages.save('conversation', 'Edited', signal)).status, 503);
  assert.equal(calls.length, 1);
  assert.equal((await savedMessages.save('conversation', undefined, signal)).status, 503);
  assert.equal(savedMessages.pending('conversation'), 'Original');
  assert.equal((await savedMessages.save('conversation', undefined, signal)).status, 201);
  assert.deepEqual(calls[1], calls[0]);
  assert.deepEqual(calls[2], calls[0]);
  assert.match(calls[0].url, /\/messages\/save$/);
  savedMessages.clear();
  assert.equal((await savedMessages.save('conversation', undefined, signal)).status, 400);
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
    if (calls.length === 2) return { status: 403 };
    return created(idea('new'));
  } }), reads.isCurrent, () => 'synthetic-key');
  const body = { title: 'Original' };
  assert.equal((await commands.submitIdea(scope, body)).kind, 'uncertain');
  body.title = 'Edited';
  assert.equal((await commands.submitIdea(scope, body)).kind, 'uncertain');
  assert.equal(calls.length, 1);
  assert.equal((await commands.submitIdea(scope)).kind, 'blocked');
  assert.equal(commands.ideaUncertain(), true);
  assert.equal((await commands.submitIdea(scope)).kind, 'created');
  assert.deepEqual(calls.map(call => [call.body.title, call.key]), Array.from({ length: 3 }, () => ['Original', 'synthetic-key']));
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
