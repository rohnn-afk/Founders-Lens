// Deterministic browser-use-case tests. In-memory storage, time and API
// replies exercise recovery and scope boundaries without rendering React.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function load(name) {
  const source = await readFile(new URL('../apps/web/features/workspace/' + name + '.ts', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext }
  });
  return import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
}

const { createMessageController } = await load('message-controller');
const { createRecoveryStorage } = await load('submission-recovery-storage');
const { createReadController } = await load('read-controller');

function setup(options = {}) {
  const records = new Map();
  const storage = {
    get length() { return records.size; },
    key: index => [...records.keys()][index] ?? null,
    getItem: key => records.get(key) ?? null,
    setItem(key, value) {
      if (options.writeDenied) throw Error('Storage write denied');
      records.set(key, value);
    },
    removeItem: key => records.delete(key)
  };
  let time = 10_000;
  const stale = createReadController(), scope = stale.enter(randomUUID());
  const ideaId = randomUUID(), conversationId = randomUUID();
  const target = { localAccountId: scope.account, ideaId, conversationId };
  const recovery = createRecoveryStorage(() => {
    if (options.denied) throw Error('Storage denied');
    return storage;
  }, 600_000, () => time);
  const controller = (api, currentScope = scope) => createMessageController(api, recovery, currentScope,
    ideaId, conversationId, stale.isCurrent, () => { stale.enter(null); recovery.clear(); }, () => time);
  return { records, target, scope, recovery, stale, controller, advance(ms) { time += ms; } };
}

function correlation(clientSubmissionId) {
  const generationId = randomUUID(), statusUrl = '/api/v1/generations/' + generationId;
  return { clientSubmissionId, messageId: randomUUID(), generationId, statusUrl, eventsUrl: statusUrl + '/events' };
}

test('one send survives a lost acknowledgement, refresh and inconclusive GETs without another POST', async () => {
  const { controller, records, scope, stale, advance } = setup();
  const lost = Promise.withResolvers();
  let posts = 0, checks = 0, sentId;
  const api = {
    submit(_id, body) { posts++; sentId = body.clientSubmissionId; return lost.promise; },
    async correlate(_id, submissionId) {
      assert.equal(submissionId, sentId);
      return ++checks < 3 ? { status: 404 } : { status: 200, data: correlation(submissionId) };
    }
  };
  const first = controller(api);
  const pending = first.send('ephemeral private text');
  assert.equal(first.state(), 'sending');
  assert.equal(await first.send('duplicate click'), undefined);
  lost.reject(Error('response lost after commit'));
  assert.equal(await pending, 'unknown');
  const [record] = records.values();
  assert.ok(!record.includes('ephemeral private text'));
  assert.equal(JSON.parse(record).expiresAt, 610_000);
  const restored = controller(api, stale.enter(scope.account));
  assert.equal(restored.restore(), 'unknown');
  advance(100);
  assert.equal(await restored.check(), 'unknown');
  assert.equal(await restored.check(), 'unknown');
  assert.deepEqual([...records.values()], [record]);
  assert.equal(await restored.check(), 'accepted');
  assert.equal(records.size, 0);
  assert.equal(posts, 1);
  assert.equal(checks, 3);
});

test('denied storage permits only in-memory GET recovery, and expired or tampered records are removed', async () => {
  const blocked = setup({ denied: true });
  assert.equal(blocked.controller({}).restore(), 'history-only');
  const denied = setup({ writeDenied: true });
  const controller = denied.controller({
    async submit() { return { status: 503 }; },
    async correlate(_id, submissionId) { return { status: 200, data: correlation(submissionId) }; }
  });
  assert.equal(await controller.send('fixture'), 'unknown');
  assert.equal(denied.records.size, 0);
  assert.equal(await controller.check(), 'accepted');
  const { target, recovery, records, advance } = setup();
  recovery.save(target, randomUUID(), randomUUID());
  advance(600_000);
  assert.equal(recovery.read(target).record, undefined);
  assert.equal(recovery.read(target).unavailable, true);
  assert.equal(records.size, 0);
  recovery.save(target, randomUUID(), randomUUID());
  const [[key, raw]] = records.entries();
  records.set(key, JSON.stringify({ ...JSON.parse(raw), content: 'invalid private field' }));
  assert.equal(recovery.read(target).record, undefined);
  assert.equal(records.size, 0);
});

test('session expiry clears recovery and late replies cannot update another account or route', async () => {
  const { controller, scope, stale, records, recovery, target } = setup();
  const reply = Promise.withResolvers();
  const first = controller({ submit: (_id, body) => reply.promise.then(() =>
    ({ status: 202, data: { ...correlation(body.clientSubmissionId), status: 'PENDING' } })) });
  const pending = first.send('fixture');
  const next = stale.enter(randomUUID(), true);
  recovery.sweep(next.account);
  reply.resolve();
  assert.equal(await pending, undefined);
  assert.equal(records.size, 0);
  assert.equal(controller({}, next).restore(), 'editing');
  recovery.save(target, randomUUID(), randomUUID());
  const reopened = controller({ async correlate() { return { status: 401 }; } }, stale.enter(scope.account, true));
  assert.equal(reopened.restore(), 'unknown');
  assert.equal(await reopened.check(), undefined);
  assert.equal(records.size, 0);
});
