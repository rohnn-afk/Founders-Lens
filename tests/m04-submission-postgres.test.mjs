// Live PostgreSQL tests for the unmounted submission router. Synthetic policy,
// identity and clearance are injected only here. Fixture cleanup is scoped.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import express from 'express';
import { connection, settings } from '../apps/api/scripts/database.mjs';
import { createDatabaseClient } from '../apps/api/dist/persistence/client.js';
import { suppressionScopeKey } from '../apps/api/dist/security/suppression-authority.js';
import { createSubmissionRepository } from '../apps/api/dist/submission/repository.js';
import { createSubmissionService } from '../apps/api/dist/submission/service.js';
import { submissionRoutes } from '../apps/api/dist/submission/routes.js';
import { WorkspaceRepository } from '../apps/api/dist/workspace/repository.js';

const policy = Object.freeze({ unit: 'synthetic_submission', operationType: 'message_submission',
  reservationUnits: 1, quotaUnits: 2, deadlineMs: 120_000, receiptTtlMs: 600_000 });
const authority = { async lookup(scope, query) {
  return { verdict: 'CLEAR', scope: suppressionScopeKey(scope), nonce: query.nonce, observedAt: Date.now(),
    validUntil: Date.now() + 1000, integrity: 'VERIFIED', coverage: 'COMPLETE', authority: 'INDEPENDENT', epoch: 'fixture-only' };
} };

async function clean(owner, ids, instance) {
  const accounts = 'SELECT id FROM "UserAccount" WHERE id=ANY($1::uuid[]) AND "clerkInstanceId"=$2';
  const ideas = 'SELECT id FROM "Idea" WHERE "ownerId" IN (' + accounts + ')';
  const conversations = 'SELECT id FROM "Conversation" WHERE "ideaId" IN (' + ideas + ')';
  const attempts = 'SELECT id FROM "GenerationAttempt" WHERE "conversationId" IN (' + conversations + ')';
  const args = [ids, instance];
  await owner.query('BEGIN');
  try {
    await owner.query('DELETE FROM "OutboxEvent" WHERE "aggregateType"=\'GenerationAttempt\' AND "aggregateId" IN (' + attempts + ')', args);
    await owner.query('DELETE FROM "UsageLedger" WHERE "accountId" IN (' + accounts + ')', args);
    await owner.query('DELETE FROM "IdempotencyRecord" WHERE "accountId" IN (' + accounts + ')', args);
    await owner.query("DELETE FROM \"Message\" WHERE role='ASSISTANT' AND \"conversationId\" IN (" + conversations + ')', args);
    await owner.query('DELETE FROM "GenerationAttempt" WHERE "conversationId" IN (' + conversations + ')', args);
    await owner.query('DELETE FROM "Message" WHERE "conversationId" IN (' + conversations + ')', args);
    await owner.query('DELETE FROM "Conversation" WHERE "ideaId" IN (' + ideas + ')', args);
    await owner.query('DELETE FROM "Idea" WHERE "ownerId" IN (' + accounts + ')', args);
    await owner.query('DELETE FROM "UserAccount" WHERE id IN (' + accounts + ')', args);
    await owner.query('COMMIT');
  } catch (error) {
    await owner.query('ROLLBACK');
    throw error;
  }
}

async function startRouter(t, services, principal) {
  const app = express();
  app.use((req, res, next) => {
    if (req.get('X-Test-Disconnect') === 'yes') {
      // Simulate a lost acknowledgement only after accept() has committed.
      res.json = () => { res.destroy(); return res; };
    }
    next();
  });
  for (const [index, service] of services.entries()) {
    app.use('/test/' + index + '/api/v1', submissionRoutes(service, async () => principal));
  }
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const send = async (index, conversationId, key, body, extra = {}) => {
    const url = 'http://127.0.0.1:' + server.address().port + '/test/' + index + '/api/v1/conversations/' + conversationId + '/messages';
    const response = await fetch(url, { method: 'POST', headers: {
      Authorization: 'Bearer test.only.token', 'Idempotency-Key': key, 'Content-Type': 'application/json', ...extra
    }, body: JSON.stringify(body) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  send.read = async (index, conversationId, path) => {
    const url = 'http://127.0.0.1:' + server.address().port + '/test/' + index + '/api/v1/conversations/' + conversationId + path;
    const response = await fetch(url, { headers: { Authorization: 'Bearer test.only.token' } });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, body: await response.json() };
  };
  return send;
}

test('isolated atomic submission, quota and replay in PostgreSQL', { skip: !process.argv.includes('--live'), timeout: 90_000 }, async t => {
  const values = await settings();
  const clients = Array.from({ length: 3 }, () => createDatabaseClient({ DATABASE_URL: values.TEST_DATABASE_URL }));
  const [runtime] = clients;
  const owner = connection(values.TEST_MIGRATION_DATABASE_URL);
  const instance = 'ins_m04fixture_' + randomUUID();
  const ids = [];
  await owner.connect();
  t.after(async () => {
    await Promise.all(clients.map(client => client.$disconnect()));
    try { if (ids.length) await clean(owner, ids, instance); } finally { await owner.end(); }
  });
  assert.deepEqual((await owner.query('SELECT current_database() AS db, current_user AS role')).rows,
    [{ db: 'founders_lens_m02_test', role: 'fl_m02_migrator' }]);
  const backends = await Promise.all(clients.map(client =>
    client.$queryRaw`SELECT current_database() AS db, current_user AS role, pg_backend_pid() AS pid`));
  assert.equal(new Set(backends.map(([row]) => row.pid)).size, 3);
  for (const [row] of backends) {
    assert.equal(row.db, 'founders_lens_m02_test');
    assert.equal(row.role, 'fl_m02_runtime');
  }

  async function founder(count) {
    const localUserId = randomUUID();
    ids.push(localUserId);
    const clerkSubject = 'user_m04_' + localUserId;
    const digest = randomBytes(32).toString('hex');
    await runtime.userAccount.create({ data: { id: localUserId, clerkSubject, clerkInstanceId: instance, subjectKey: digest } });
    const idea = await runtime.idea.create({ data: { ownerId: localUserId, title: 'M04 fixture' } });
    const conversations = await Promise.all(Array.from({ length: count }, () => runtime.conversation.create({ data: { ideaId: idea.id } })));
    return { principal: { localUserId, clerkSubject, clerkInstanceId: instance, accountStatus: 'ACTIVE',
      subjectKeys: [{ version: 1, digest }], sessionId: 'sess_synthetic', requestId: randomUUID() },
    conversations: conversations.map(row => row.id) };
  }

  const start = Date.parse('2026-01-01T00:00:00Z');
  let time = start;
  const clock = () => new Date(time);
  const cursorSecret = randomBytes(32);
  const service = (client, injected = policy) => createSubmissionService(createSubmissionRepository(client), authority,
    { clock, policy: injected, cursorSecret });
  const services = clients.map(client => service(client));
  const makeBody = () => ({ clientSubmissionId: randomUUID(), content: 'M04 private synthetic content' });
  const scope = conversationId => ({ conversationId });
  const denial = code => error => error?.code === code;

  async function effects(actor, id, expected) {
    const accountId = actor.localUserId;
    const [messages, attempts, ledger, receipts, conversation] = await Promise.all([
      runtime.message.findMany({ where: scope(id) }), runtime.generationAttempt.findMany({ where: scope(id) }),
      runtime.usageLedger.findMany({ where: { accountId } }),
      runtime.idempotencyRecord.findMany({ where: { accountId, targetScope: id } }),
      runtime.conversation.findUniqueOrThrow({ where: { id } })
    ]);
    assert.equal(messages.length, expected);
    assert.equal(attempts.length, expected);
    assert.equal(conversation.nextSequence, expected + 1);
    const outbox = await runtime.outboxEvent.findMany({ where: { aggregateId: { in: attempts.map(row => row.id) } } });
    assert.equal(outbox.length, expected);
    for (const event of outbox) {
      assert.equal(event.status, 'PENDING');
      assert.equal(event.publishedAt, null);
      assert.equal(event.dispatchAttempts, 0);
      assert.deepEqual(event.payload, { generationId: event.aggregateId });
    }
    return { messages, attempts, ledger, receipts, outbox, conversation };
  }

  await t.test('three concurrent conversations consume exactly two account-wide units', async () => {
    const { principal, conversations } = await founder(3);
    const requests = conversations.map(id => ({ id, body: makeBody(), key: 'quota-' + randomUUID() }));
    const results = await Promise.allSettled(requests.map(({ id, key, body }, i) => services[i].submit(principal, id, key, body)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
    const ledger = await runtime.usageLedger.findMany({ where: { accountId: principal.localUserId } });
    assert.equal(ledger.length, 2);
    for (const [index, result] of results.entries()) {
      const { id, key, body } = requests[index];
      const accepted = result.status === 'fulfilled';
      const state = await effects(principal, id, Number(accepted));
      if (!accepted) {
        assert.equal(result.reason.code, 'QUOTA_EXCEEDED');
        assert.equal(state.receipts.length, 0);
        continue;
      }
      const ref = result.value, attempt = state.attempts[0], message = state.messages[0];
      const reserved = ledger.find(row => row.reservationId === ref.generationId);
      assert.ok(reserved);
      assert.equal(reserved.unit, policy.unit);
      assert.equal(reserved.operationType, policy.operationType);
      assert.equal(reserved.reservationState, 'RESERVED');
      assert.equal(reserved.provider, null);
      assert.equal(reserved.reservedUnits.toFixed(5), '1.00000');
      assert.equal(reserved.measuredUnits.toFixed(5), '0.00000');
      assert.equal(reserved.reconciliationKey, 'message-submission:' + ref.generationId);
      assert.equal(message.id, ref.messageId);
      assert.equal(message.role, 'USER');
      assert.equal(message.sequence, 1);
      assert.deepEqual(message.content, { text: body.content });
      assert.equal(attempt.id, ref.generationId);
      assert.equal(attempt.triggerMessageId, message.id);
      assert.equal(attempt.attemptNumber, 1);
      assert.equal(attempt.status, 'PENDING');
      assert.equal(attempt.deadlineAt.getTime(), start + 120_000);
      assert.equal(state.receipts.length, 1);
      assert.equal(state.receipts[0].expiresAt.getTime(), start + 600_000);
      assert.equal(state.receipts[0].key, key);
      assert.deepEqual(state.receipts[0].responseRef, ref);
      assert.deepEqual(await services[0].submit(principal, id, key, body), ref);
    }
    assert.equal(await runtime.usageLedger.count({ where: { accountId: principal.localUserId } }), 2);
  });

  async function seedUsage(principal, reservationState, reservedUnits, measuredUnits, overrides = {}) {
    const reservationId = randomUUID();
    await runtime.usageLedger.create({ data: { accountId: principal.localUserId, operationType: policy.operationType,
      unit: policy.unit, reservationId, reconciliationKey: 'm04-quota-fixture:' + reservationId,
      reservationState, reservedUnits, measuredUnits, occurredAt: clock(), ...overrides } });
    return reservationId;
  }

  await t.test('quota counts open reserves, measured settlement and zero-cost release in the existing scope', async () => {
    for (const [state, reserved, measured] of [['RESERVED', 2, 0], ['SETTLED', 1, 2]]) {
      const { principal, conversations: [id] } = await founder(1);
      await seedUsage(principal, state, reserved, measured);
      await assert.rejects(services[0].submit(principal, id, 'quota-state-denial', makeBody()), denial('QUOTA_EXCEEDED'));
      const unchanged = await effects(principal, id, 0);
      assert.equal(unchanged.ledger.length, 1);
      assert.equal(unchanged.receipts.length, 0);
    }

    const { principal, conversations } = await founder(2);
    await seedUsage(principal, 'SETTLED', 2, 1);
    await seedUsage(principal, 'RELEASED', 2, 0);
    await seedUsage(principal, 'RESERVED', 2, 0, { unit: 'separate_unit' });
    await seedUsage(principal, 'RESERVED', 2, 0, { operationType: 'separate_operation' });
    const payloads = conversations.map(makeBody);
    const results = await Promise.allSettled(conversations.map((id, index) =>
      services[index].submit(principal, id, 'last-unit-' + index, payloads[index])));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    for (const [index, result] of results.entries()) {
      const id = conversations[index];
      if (result.status === 'rejected') {
        assert.equal(result.reason.code, 'QUOTA_EXCEEDED');
        assert.equal((await effects(principal, id, 0)).receipts.length, 0);
        continue;
      }
      const original = await effects(principal, id, 1);
      assert.equal(original.ledger.length, 5);
      // A full budget does not block replay or charge it again after receipt expiry.
      for (const timestamp of [start, start + policy.receiptTtlMs]) {
        time = timestamp;
        try {
          assert.deepEqual(await services[2].submit(principal, id, 'last-unit-' + index, payloads[index]), result.value);
          assert.deepEqual(await effects(principal, id, 1), original);
        } finally { time = start; }
      }
    }
  });

  await t.test('inconsistent accounting fails closed without writing any admission effects', async () => {
    for (const [state, measured] of [['RELEASED', 1], ['RESERVED', 1], ['SETTLED', 0]]) {
      const { principal, conversations: [id] } = await founder(1);
      const reservationId = await seedUsage(principal, state, 1, measured);
      if (state === 'SETTLED') {
        // PostgreSQL numeric NaN passes the existing nonnegative constraint.
        await runtime.$executeRaw`UPDATE "UsageLedger" SET "measuredUnits"='NaN'::numeric
          WHERE "reservationId"=${reservationId}::uuid AND "accountId"=${principal.localUserId}::uuid`;
      }
      await assert.rejects(services[0].submit(principal, id, 'invalid-ledger-fixture', makeBody()), denial('DEPENDENCY_UNAVAILABLE'));
      const unchanged = await effects(principal, id, 0);
      assert.equal(unchanged.ledger.length, 1);
      assert.equal(unchanged.receipts.length, 0);
    }
  });

  await t.test('same-key races, alternate keys, expiry and later attempt state preserve original acceptance', async t => {
    const { principal, conversations: [id, other, third] } = await founder(3);
    const body = makeBody(), key = 'replay-fixture';
    const send = await startRouter(t, services, principal);
    const attempts = await Promise.all(services.map((_, i) => send(i, id, key, body)));
    const first = attempts[0];
    for (const response of attempts) {
      assert.equal(response.status, 202);
      assert.deepEqual(response.body, first.body);
    }
    const changed = { ...body, content: 'Changed content' };
    assert.equal((await send(0, id, key, changed)).body.error.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal((await send(0, id, 'new-key-fixture', changed)).body.error.code, 'CONFLICT');
    assert.equal((await send(0, id, 'other-intent', makeBody())).body.error.code, 'GENERATION_IN_PROGRESS');
    const alias = await send(1, id, 'new-key-fixture', body);
    assert.deepEqual(alias.body, first.body);
    assert.equal((await send(0, other, 'account-b-second', makeBody())).status, 202);
    const quota = await send(0, third, 'account-b-third', makeBody());
    assert.equal(quota.status, 429);
    assert.equal(quota.body.error.code, 'QUOTA_EXCEEDED');
    assert.equal(quota.body.error.retryable, false);
    assert.equal(quota.headers.get('retry-after'), null);
    const before = await effects(principal, id, 1);
    assert.equal(before.ledger.length, 2, 'Second account has its own quota');
    assert.equal(before.receipts.length, 2);
    await runtime.generationAttempt.update({ where: { id: first.body.generationId }, data: { status: 'FAILED', completedAt: new Date(start) } });
    for (const elapsed of [599_999, 600_000, 600_001]) {
      time = start + elapsed;
      const replay = await send(2, id, key, body);
      assert.equal(replay.status, 202);
      assert.equal(replay.headers.get('location'), first.headers.get('location'));
      assert.deepEqual(replay.body, first.body);
    }
    assert.equal((await send(0, id, key, changed)).body.error.code, 'IDEMPOTENCY_KEY_REUSED');
    const after = await effects(principal, id, 1);
    assert.deepEqual(after.receipts, before.receipts);
    assert.equal(after.ledger.length, 2);
    time = start;
  });

  await t.test('missing or invalid policy and late failure leave no partial writes', async t => {
    const { principal, conversations: [id] } = await founder(1);
    const body = makeBody();
    const missing = createSubmissionService(createSubmissionRepository(runtime), authority, { clock });
    const send = await startRouter(t, [missing, service(runtime, { ...policy, quotaUnits: 0 })], principal);
    for (const index of [0, 1]) {
      const denied = await send(index, id, 'missing-or-invalid-policy', body);
      assert.equal(denied.status, 503);
      assert.equal(denied.body.error.code, 'DEPENDENCY_UNAVAILABLE');
      assert.ok(!JSON.stringify(denied.body).includes(body.content));
    }
    let attemptedOutbox;
    const broken = runtime.$extends({ query: { $executeRaw({ args, query }) {
      if (args.strings?.[0]?.includes('INSERT INTO "OutboxEvent"')) {
        attemptedOutbox = args.values[2];
        throw new Error('Synthetic late write failure');
      }
      return query(args);
    } } });
    await assert.rejects(service(broken).submit(principal, id, 'rollback-key', body), /Synthetic late write failure/);
    assert.ok(attemptedOutbox);
    assert.equal(await runtime.outboxEvent.count({ where: { aggregateId: attemptedOutbox } }), 0);
    const state = await effects(principal, id, 0);
    assert.equal(state.ledger.length, 0);
    assert.equal(state.receipts.length, 0);
  });

  await t.test('expired and corrupt receipt behavior is distinguishable at the clock boundary', async () => {
    const { principal, conversations: [id] } = await founder(1);
    const body = makeBody(), key = 'expiry-fixture';
    const accepted = await services[0].submit(principal, id, key, body);
    const receipt = await runtime.idempotencyRecord.findFirstOrThrow({ where: { accountId: principal.localUserId, key } });
    const corrupted = await runtime.idempotencyRecord.update({ where: { id: receipt.id }, data: { responseRef: {} } });
    try {
      time = start + 599_999;
      await assert.rejects(services[1].submit(principal, id, key, body), denial('DEPENDENCY_UNAVAILABLE'));
      time = start + 600_000;
      assert.deepEqual(await services[1].submit(principal, id, key, body), accepted);
      assert.deepEqual(await runtime.idempotencyRecord.findUnique({ where: { id: receipt.id } }), corrupted);
      const missingAttempt = runtime.$extends({ query: { message: { async findUnique({ args, query }) {
        const result = await query(args);
        return { ...result, triggeringAttempts: [] };
      } } } });
      await assert.rejects(service(missingAttempt).submit(principal, id, key, body), denial('DEPENDENCY_UNAVAILABLE'));
      assert.equal((await effects(principal, id, 1)).ledger.length, 1);
    } finally {
      time = start;
    }
  });

  await t.test('a committed response can be lost without duplicating work', async t => {
    const { principal, conversations: [id] } = await founder(1);
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const gated = { ...services[0], async submit(...args) {
      entered.resolve();
      await release.promise;
      return services[0].submit(...args);
    } };
    const send = await startRouter(t, [gated, ...services.slice(1)], principal), body = makeBody();
    const path = '/submissions/' + body.clientSubmissionId;
    const lost = assert.rejects(send(0, id, 'lost-reply', body, { 'X-Test-Disconnect': 'yes' }), TypeError);
    await entered.promise;
    try { assert.equal((await send.read(1, id, path)).status, 404); }
    finally { release.resolve(); await lost; }
    const state = await effects(principal, id, 1);
    for (const index of [0, 1, 2]) {
      const { status, body: recovered } = await send.read(index, id, path);
      assert.equal(status, 200);
      assert.equal(recovered.clientSubmissionId, body.clientSubmissionId);
      assert.equal(recovered.messageId, state.messages[0].id);
      assert.equal(recovered.generationId, state.attempts[0].id);
    }
    assert.deepEqual(await effects(principal, id, 1), state);
    const replay = await send(1, id, 'lost-reply', body);
    assert.equal(replay.status, 202);
    assert.equal(replay.body.messageId, state.messages[0].id);
    assert.equal(replay.body.generationId, state.attempts[0].id);
    assert.equal((await effects(principal, id, 1)).ledger.length, 1);
  });

  await t.test('logical transcript pages select the regenerated reply and correlation stays on attempt one', async t => {
    const { principal, conversations: [id, other] } = await founder(2);
    const foreign = await founder(1);
    const send = await startRouter(t, services, principal);
    const ideaId = (await runtime.conversation.findUniqueOrThrow({ where: { id } })).ideaId;
    const first = makeBody(), second = { ...makeBody(), content: 'Second turn' };
    const original = (await send(0, id, 'first-turn', first)).body;
    await runtime.generationAttempt.update({ where: { id: original.generationId },
      data: { status: 'FAILED', completedAt: clock() } });
    const next = (await send(0, id, 'second-turn', second)).body;
    const selected = await runtime.generationAttempt.create({ data: {
      conversationId: id, triggerMessageId: original.messageId, attemptNumber: 2, status: 'COMPLETED',
      completedAt: clock(), selectedAt: clock(), deadlineAt: new Date(time + 120_000)
    } });
    const answer = await runtime.message.create({ data: { conversationId: id, ideaId, sequence: 3, role: 'ASSISTANT',
      generationAttemptId: selected.id, content: { text: 'Selected answer' } } });
    const path = '/messages?limit=1';
    let result = await send.read(0, id, path);
    for (const expected of [original.messageId, answer.id, next.messageId]) {
      assert.equal(result.status, 200);
      assert.deepEqual(result.body.items.map(message => message.id), [expected]);
      const cursor = result.body.page.nextCursor;
      if (!cursor) {
        assert.equal(expected, next.messageId);
        assert.equal(result.body.page.hasMore, false);
        break;
      }
      assert.equal((await send.read(0, other, path + '&cursor=' + encodeURIComponent(cursor))).status, 400);
      result = await send.read(0, id, path + '&cursor=' + encodeURIComponent(cursor));
    }
    assert.deepEqual((await send.read(0, other, '/messages')).body, { items: [], page: { hasMore: false, nextCursor: null } });
    assert.equal((await send.read(0, foreign.conversations[0], '/messages')).status, 404);
    assert.equal((await send.read(0, id, '/submissions/' + first.clientSubmissionId)).body.generationId, original.generationId);
    const orphan = makeBody();
    await runtime.message.create({ data: { conversationId: other, ideaId, sequence: 1, role: 'USER',
      clientSubmissionKey: orphan.clientSubmissionId, submissionSha256: '0'.repeat(64), content: { text: orphan.content } } });
    assert.equal((await send.read(0, other, '/submissions/' + orphan.clientSubmissionId)).body.error.code, 'PROJECTION_UNAVAILABLE');
    await runtime.message.updateMany({ where: { conversationId: other }, data: { contentSchemaVersion: 99 } });
    assert.equal((await send.read(0, other, '/messages')).body.error.code, 'PROJECTION_UNAVAILABLE');
  });

  await t.test('correlation rechecks account lifecycle after obtaining independent clearance', async t => {
    const { principal, conversations: [id] } = await founder(1);
    const body = makeBody();
    await services[0].submit(principal, id, 'lock-read-fixture', body);
    const cleared = Promise.withResolvers(), locked = Promise.withResolvers(), release = Promise.withResolvers();
    const observedAuthority = { async lookup(scope, query) {
      if (scope.kind === 'IDEA') cleared.resolve();
      return authority.lookup(scope, query);
    } };
    const reader = createSubmissionService(createSubmissionRepository(clients[1]), observedAuthority, { clock, cursorSecret });
    const send = await startRouter(t, [reader], principal);
    const statusUpdate = runtime.$transaction(async tx => {
      await tx.userAccount.update({ where: { id: principal.localUserId }, data: { status: 'DISABLED' } });
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const pending = send.read(0, id, '/submissions/' + body.clientSubmissionId);
    try { await cleared.promise; }
    finally { release.resolve(); await statusUpdate; }
    assert.equal((await pending).status, 403);
  });

  await t.test('foreign and archived conversations leave no acceptance effects', async () => {
    const first = await founder(1), other = await founder(1);
    await assert.rejects(services[0].submit(first.principal, other.conversations[0], 'foreign-id', makeBody()),
      denial('RESOURCE_NOT_FOUND'));
    await runtime.conversation.update({ where: { id: first.conversations[0] }, data: { status: 'ARCHIVED' } });
    await assert.rejects(services[0].submit(first.principal, first.conversations[0], 'archived-id', makeBody()),
      denial('RESOURCE_NOT_FOUND'));
    const state = await effects(first.principal, first.conversations[0], 0);
    assert.equal(state.receipts.length + state.ledger.length, 0);
  });

  await t.test('submission waits on the same account row lock as M03', async () => {
    const { principal, conversations: [id] } = await founder(1);
    const release = Promise.withResolvers(), entered = Promise.withResolvers();
    const held = new WorkspaceRepository(runtime).transaction(principal, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const pending = services[1].submit(principal, id, 'workspace-lock', makeBody());
    try {
      let waiting = false;
      for (let retry = 0; retry < 40 && !waiting; retry++) {
        // A restricted role's SQL text can be hidden from the verifier. The
        // blocker relation is available without widening either role's grants.
        const { rows } = await owner.query(`SELECT 1 FROM pg_stat_activity waiter
          JOIN pg_stat_activity blocker ON blocker.pid = ANY(pg_blocking_pids(waiter.pid))
          WHERE waiter.datname=current_database() AND waiter.usename='fl_m02_runtime'
            AND blocker.datname=waiter.datname AND blocker.usename=waiter.usename`);
        waiting = rows.length > 0;
        if (!waiting) await delay(25);
      }
      assert.equal(waiting, true, 'PostgreSQL must observe a blocked account lock');
      assert.equal((await effects(principal, id, 0)).ledger.length, 0);
    } finally {
      release.resolve();
      await held;
      await pending;
    }
    assert.equal((await effects(principal, id, 1)).ledger.length, 1);
  });
});
