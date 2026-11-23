// Runtime recovery proof. Deterministic signature cases run by default; the
// opt-in PostgreSQL case creates and removes only its own Compose project.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import test from 'node:test';
import { Pool } from 'pg';
import { createApp } from '../apps/api/dist/app.js';
import { createRuntimeRecoveryClearance } from '../apps/api/dist/privacy/runtime-recovery-clearance.js';
import { createSuppressionLedger } from '../apps/api/dist/security/suppression-ledger.js';
import { SubjectKeys, subjectLock } from '../apps/api/dist/security/subject-key.js';
import { PrismaIdentityRepository } from '../apps/api/dist/security/identity-repository.js';
import { withP6Provisioning } from './fixtures/p6-local-operator.mjs';
import { PrismaClient } from '../apps/api/dist/generated/prisma/client.js';
import { WorkspaceCursor } from '../apps/api/dist/workspace/contracts.js';
import { WorkspaceRepository } from '../apps/api/dist/workspace/repository.js';
import { WorkspaceService } from '../apps/api/dist/workspace/service.js';
import { localConversationOperations } from '../apps/api/dist/workspace/local-conversations.js';

const { PrismaPg } = createRequire(new URL('../apps/api/package.json', import.meta.url))('@prisma/adapter-pg');

const operator = generateKeyPairSync('ed25519');
const subjectKeys = new SubjectKeys(2, new Map([[1, randomBytes(32)], [2, randomBytes(32)]]));
const denied = { code: 'DEPENDENCY_UNAVAILABLE' };
const namespace = 'hmac-sha256-v1:' + 'a'.repeat(64);

/** Create a short-lived fixture payload in canonical field order. */
function decisionFor(primaryTarget, snapshot, changes = {}) {
  const issuedAt = Date.now() - 1;
  return { version: 1, purpose: 'founders-lens:local-workspace:read-only', primaryTarget,
    authorityIdentity: snapshot.authorityIdentity, namespace: snapshot.namespace,
    epoch: snapshot.epoch, recoveryRun: randomUUID(), inventoryDigest: snapshot.inventoryDigest,
    subjectVersions: snapshot.subjectVersions, issuedAt, expiresAt: issuedAt + 60_000, ...changes };
}

/** Test-only signer. The runtime receives only its public key and signed envelope. */
function signed(decision, key = operator.privateKey, json = JSON.stringify(decision)) {
  const payload = Buffer.from(json);
  return JSON.stringify({ payload: payload.toString('base64url'), signature: sign(null, payload, key).toString('base64url') });
}

test('runtime recovery rejects unsigned, malformed, expired and noncanonical decisions before I/O', async () => {
  const snapshot = { authorityIdentity: '202:10', namespace, epoch: randomUUID(),
    inventoryDigest: 'b'.repeat(64), subjectVersions: [1, 2] };
  const decision = decisionFor('101:10', snapshot);
  let reads = 0;
  const primary = { options: { connectionTimeoutMillis: 1000 }, query: async () => {
    reads++;
    return { rows: [{ identity: '101:10' }] };
  } };
  const authority = { runtimeSnapshot: async () => snapshot };
  const guard = (encoded, operatorPublicKey = operator.publicKey) => createRuntimeRecoveryClearance({
    decision: encoded, operatorPublicKey, primary, authority, subjectKeys
  });
  const wrongKey = generateKeyPairSync('ed25519');
  for (const encoded of ['{}', signed(decision, wrongKey.privateKey),
    signed(decision, operator.privateKey, JSON.stringify(decision, null, 1)),
    signed({ ...decision, purpose: 'write' }), signed({ ...decision, unexpected: true }),
    signed({ ...decision, issuedAt: Date.now() - 2000, expiresAt: Date.now() - 1000 }),
    signed({ ...decision, issuedAt: Date.now() + 2000 }),
    signed({ ...decision, expiresAt: Date.now() + 600_000 }),
    signed({ ...decision, subjectVersions: [2, 1] })]) {
    await assert.rejects(guard(encoded).assertClearance(), denied);
  }
  await assert.rejects(guard(signed(decision), operator.privateKey).assertClearance(), denied);
  assert.equal(reads, 0);
  const verifier = guard(signed(decision));
  assert.deepEqual(Object.keys(verifier), ['assertClearance', 'verifiedDeadline', 'verifiedDecision']);
  await verifier.assertClearance();
  assert.deepEqual(await verifier.verifiedDecision(), decision);
  assert.equal(reads, 2);
  const create = 'founders-lens:local-workspace:create-idea';
  const writeGuard = encoded => createRuntimeRecoveryClearance({ decision: encoded, operatorPublicKey: operator.publicKey,
    primary, authority, subjectKeys, purpose: create });
  await assert.rejects(writeGuard(signed(decision)).assertClearance(), denied);
  await assert.rejects(guard(signed({ ...decision, purpose: create })).assertClearance(), denied);
  assert.equal(await writeGuard(signed({ ...decision, purpose: create })).verifiedDeadline(), decision.expiresAt);
  const p8 = ['read-conversations', 'create-conversation', 'save-user-message']
    .map(operation => 'founders-lens:local-workspace:' + operation);
  for (const purpose of p8) {
    const verifier = encoded => createRuntimeRecoveryClearance({ decision: encoded, operatorPublicKey: operator.publicKey,
      primary, authority, subjectKeys, purpose });
    for (const other of [decision.purpose, create, ...p8]) {
      const check = verifier(signed({ ...decision, purpose: other })).assertClearance();
      if (other === purpose) await check;
      else await assert.rejects(check, denied);
    }
  }
});

test('normal startup has no private idea route', async t => {
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(origin + '/api/v1/ideas')).status, 404);
  assert.equal((await fetch(origin + '/health/ready')).status, 503);
});

/** Reserve two available loopback ports while selecting them, then release for Compose. */
async function selectPorts() {
  const reservations = [createServer(), createServer()];
  await Promise.all(reservations.map(async server => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  }));
  const ports = reservations.map(server => server.address().port);
  await Promise.all(reservations.map(server => new Promise(resolve => server.close(resolve))));
  return ports;
}

test('runtime decision is invalidated by live PostgreSQL target and authority changes', {
  skip: !process.argv.includes('--p6-runtime-recovery-live'), timeout: 150_000
}, async t => {
  const [authorityPort, primaryPort] = await selectPorts();
  const project = 'fl-p6-recovery-' + randomUUID();
  const [adminPassword, readerPassword, writerPassword, primaryPassword] =
    Array.from({ length: 4 }, () => randomBytes(32).toString('hex'));
  const env = { ...process.env, FL_SUPPRESSION_PORT: String(authorityPort),
    FL_SUPPRESSION_PRIMARY_PORT: String(primaryPort), FL_SUPPRESSION_ADMIN_PASSWORD: adminPassword,
    FL_SUPPRESSION_READER_PASSWORD: readerPassword, FL_SUPPRESSION_WRITER_PASSWORD: writerPassword,
    FL_SUPPRESSION_PRIMARY_PASSWORD: primaryPassword };
  const compose = (...args) => {
    const result = spawnSync('docker', ['compose', '-p', project, '-f',
      'tests/fixtures/suppression-ledger.compose.yaml', '--profile', 'rollback', ...args],
    { env, encoding: 'utf8', timeout: 70_000, windowsHide: true });
    assert.equal(result.status, 0, 'Owned Compose command failed: ' + args[0]);
    return result.stdout.trim();
  };
  const pools = [];
  const pool = (port, database, user, password) => {
    const connection = new Pool({ host: '127.0.0.1', port, database, user, password,
      connectionTimeoutMillis: 800, statement_timeout: 1000, query_timeout: 1500 });
    connection.on('error', () => {});
    pools.push(connection);
    return connection;
  };
  t.after(async () => {
    try { await Promise.all(pools.map(connection => connection.end())); }
    finally {
      compose('down', '--volumes');
      assert.equal(compose('ps', '-aq'), '');
    }
  });
  compose('up', '-d', '--wait', '--wait-timeout', '40');
  const primary = pool(primaryPort, 'primary_proof', 'postgres', primaryPassword);
  const admin = pool(authorityPort, 'suppression_proof', 'postgres', adminPassword);
  const reader = pool(authorityPort, 'suppression_proof', 'ledger_reader', readerPassword);
  const writer = pool(authorityPort, 'suppression_proof', 'ledger_writer', writerPassword);
  const epoch = randomUUID();
  const integrityKey = randomBytes(32);
  const challengeKey = randomBytes(32);
  const subjectVersions = [1, 2];
  const hmac = (key, value) => createHmac('sha256', key).update(JSON.stringify(value)).digest('hex');
  const pin = 'hmac-sha256-v1:' + hmac(challengeKey, ['deletion-challenge-namespace-v1']);
  const trust = { epoch, integrityKey, challengeNamespace: pin, subjectVersions };
  const authority = createSuppressionLedger(reader, trust);
  // Database discovery grants no authority to seal coverage or write intents.
  await admin.query('GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO ledger_reader');
  await assert.rejects(authority.runtimeSnapshot());
  const coverage = currentEpoch => hmac(integrityKey, ['suppression-coverage-v2', currentEpoch, subjectVersions, pin]);
  await admin.query('INSERT INTO authority.coverage VALUES(true,$1,$2,$3,$4)', [epoch, coverage(epoch), subjectVersions, pin]);
  const snapshot = await authority.runtimeSnapshot();
  const primaryTarget = (await primary.query(`SELECT system_identifier::text || ':' || d.oid::text AS identity
    FROM pg_catalog.pg_control_system(), pg_catalog.pg_database d WHERE d.datname=current_database()`)).rows[0].identity;
  const original = decisionFor(primaryTarget, snapshot);
  const guard = (decision = original, overrides = {}) => createRuntimeRecoveryClearance({
    decision: signed(decision), operatorPublicKey: operator.publicKey, primary, authority, subjectKeys, ...overrides
  });
  const verifier = guard();
  await verifier.assertClearance();

  await t.test('the local maintenance window admits one backend and leaves writers closed on uncertainty', async () => {
    const oldPassword = randomBytes(32).toString('hex');
    await primary.query(`CREATE ROLE fl_p6_workspace LOGIN;
      CREATE ROLE fl_p6_provision LOGIN NOINHERIT PASSWORD '${oldPassword}';
      CREATE TABLE binding_probe (id integer PRIMARY KEY);
      GRANT SELECT, INSERT ON binding_probe TO fl_p6_provision`);
    const old = pool(primaryPort, 'primary_proof', 'fl_p6_provision', oldPassword);
    await old.query('SELECT 1');
    await writer.query('SELECT 1');
    const context = { primary, authority: admin, verify: () => verifier.assertClearance(),
      provision: password => pool(primaryPort, 'primary_proof', 'fl_p6_provision', password) };
    await withP6Provisioning(context, async provision => {
      await assert.rejects(old.query('SELECT 1'), { code: '28P01' });
      await assert.rejects(writer.query('SELECT 1'), { code: '28000' });
      await assert.rejects(admin.query('UPDATE authority.inventory_count SET total=1'), { code: '57014' });
      await provision.query('INSERT INTO binding_probe VALUES (1)');
    });
    assert.equal((await primary.query('SELECT count(*)::int AS total FROM binding_probe')).rows[0].total, 1);
    await primary.query('GRANT fl_p6_provision TO fl_p6_workspace');
    await assert.rejects(withP6Provisioning(context, () => assert.fail('Membership bypass reached provisioning')), /Unexpected P6 role/);
    await primary.query('REVOKE fl_p6_provision FROM fl_p6_workspace');
    const interrupted = new Error('Uncertain fixture outcome');
    await assert.rejects(withP6Provisioning(context, () => { throw interrupted; }), interrupted);
    for (const [connection, roles] of [[primary, ['fl_p6_provision', 'fl_p6_workspace']], [admin, ['ledger_writer']]]) {
      const { rows: [state] } = await connection.query('SELECT bool_and(NOT rolcanlogin) AS closed FROM pg_roles WHERE rolname=ANY($1)', [roles]);
      assert.equal(state.closed, true);
    }
    await admin.query('ALTER ROLE ledger_writer LOGIN');
  });

  await t.test('restricted PostgreSQL workspace queries isolate owners and reject cursor replay', async workspaceTest => {
    const workspacePassword = randomBytes(32).toString('hex');
    await primary.query(await readFile('apps/api/prisma/migrations/0001_approved_baseline/migration.sql', 'utf8'));
    await primary.query(`ALTER ROLE fl_p6_workspace LOGIN PASSWORD '${workspacePassword}'`);
    const grants = await readFile('tests/fixtures/p6-primary-grants.sql', 'utf8');
    await primary.query(grants.replaceAll('founders_lens_p6_local', 'primary_proof'));
    await workspaceTest.test('restricted provisioning applies database defaults and preserves denial and replay', async () => {
      const password = randomBytes(32).toString('hex');
      await primary.query(`ALTER ROLE fl_p6_provision LOGIN PASSWORD '${password}'`);
      const connection = pool(primaryPort, 'primary_proof', 'fl_p6_provision', password);
      const prisma = new PrismaClient({ adapter: new PrismaPg(connection), log: [], errorFormat: 'minimal' });
      const account = suffix => ({ instanceId: 'ins_fixture', subject: `user_provision_${suffix}` });
      const keys = identity => subjectKeys.derive(identity.instanceId, identity.subject);
      const repository = new PrismaIdentityRepository(prisma);
      const resolve = identity => repository.resolve(identity, keys(identity), 1);
      try {
        // Keep the authenticated backend alive while preventing fresh provisioning logins.
        await connection.query('SELECT 1');
        await primary.query('ALTER ROLE fl_p6_provision NOLOGIN PASSWORD NULL');
        const identity = account('valid');
        const created = await resolve(identity);
        assert.deepEqual(await resolve(identity), created);
        const { rows: [defaults] } = await primary.query(`SELECT status,"preferencesVersion",preferences,
          "createdAt" IS NOT NULL AND "createdAt" <= clock_timestamp() AS timestamped FROM "UserAccount" WHERE id=$1`, [created.id]);
        assert.deepEqual(defaults, { status: 'ACTIVE', preferencesVersion: 1, preferences: {}, timestamped: true });
        const blocked = account('blocked');
        const locker = await primary.connect();
        let blockedResult;
        try {
          await locker.query('BEGIN');
          await locker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [subjectLock(blocked.instanceId, blocked.subject)]);
          blockedResult = assert.rejects(resolve(blocked), { code: 'ACCOUNT_UNAVAILABLE' });
          void blockedResult.catch(() => {});
          let waiting = false;
          for (let attempt = 0; attempt < 40 && !waiting; attempt++) {
            const { rows: [state] } = await primary.query(`SELECT EXISTS (SELECT FROM pg_stat_activity
              WHERE usename='fl_p6_provision' AND wait_event='advisory') AS waiting`);
            waiting = state.waiting;
            if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
          }
          assert.ok(waiting, 'Provisioning did not wait on the subject lock');
          await locker.query(`INSERT INTO "IdentityTombstone" (id,"clerkInstanceId","subjectKey","subjectKeyVersion","requestedAt")
            VALUES ($1,$2,$3,1,now())`, [randomUUID(), blocked.instanceId, keys(blocked)[0].digest]);
          await locker.query('COMMIT');
          await blockedResult;
        } finally {
          try { await locker.query('ROLLBACK'); } finally { locker.release(); }
        }
        const deleting = account('deleting');
        await primary.query(`INSERT INTO "DataOperation" (id,kind,"deadlineAt","clerkInstanceId","ownerSubjectKey",
          "subjectKeyVersion","deletionScopeKey","deletionState","policyVersion")
          VALUES ($1,'DELETE_ACCOUNT',now()+interval '1 minute',$2,$3,1,$4,'DELETION_REQUESTED','p6-fixture')`,
        [randomUUID(), deleting.instanceId, keys(deleting)[0].digest, `account:${randomUUID()}`]);
        await assert.rejects(resolve(deleting), { code: 'ACCOUNT_UNAVAILABLE' });
        let rawQueries = 0;
        const interrupted = prisma.$extends({ query: { async $queryRaw({ args, query }) {
          const result = await query(args);
          if (++rawQueries === 2) throw new Error('Disposable post-INSERT fault');
          return result;
        } } });
        await assert.rejects(new PrismaIdentityRepository(interrupted).resolve(account('rollback'), keys(account('rollback')), 1),
          { code: 'DEPENDENCY_UNAVAILABLE' });
        assert.equal(rawQueries, 2);
        // Use the existing read role for a real INSERT denial without changing either role's grants.
        const deniedPool = pool(primaryPort, 'primary_proof', 'fl_p6_workspace', workspacePassword);
        const deniedPrisma = new PrismaClient({ adapter: new PrismaPg(deniedPool), log: [], errorFormat: 'minimal' });
        try {
          await assert.rejects(new PrismaIdentityRepository(deniedPrisma).resolve(account('denied'), keys(account('denied')), 1),
            { code: 'DEPENDENCY_UNAVAILABLE', message: 'A required dependency is unavailable.' });
        } finally { await deniedPrisma.$disconnect(); }
        const { rows: [counts] } = await primary.query(`SELECT (SELECT count(*)::int FROM "UserAccount") AS accounts,
          (SELECT count(*)::int FROM "Idea") AS ideas, (SELECT count(*)::int FROM "Conversation") AS conversations,
          (SELECT count(*)::int FROM "Message") AS messages`);
        assert.deepEqual(counts, { accounts: 1, ideas: 0, conversations: 0, messages: 0 });
      } finally { await prisma.$disconnect(); }
    });
    const makePrincipal = async suffix => {
      const localUserId = randomUUID(), clerkInstanceId = 'ins_fixture', clerkSubject = `user_${suffix}`;
      const keys = subjectKeys.derive(clerkInstanceId, clerkSubject);
      await primary.query(`INSERT INTO "UserAccount" (id,"clerkSubject","clerkInstanceId","subjectKey","subjectKeyVersion","updatedAt")
        VALUES ($1,$2,$3,$4,$5,clock_timestamp())`, [localUserId, clerkSubject, clerkInstanceId, keys[0].digest, keys[0].version]);
      return { localUserId, clerkInstanceId, clerkSubject, subjectKeys: keys, accountStatus: 'ACTIVE' };
    };
    const [owner, foreign, empty] = await Promise.all(['owner','foreign','empty'].map(makePrincipal));
    for (const [account, title] of [[owner, 'owned first'], [owner, 'owned second'], [foreign, 'foreign']]) {
      await primary.query(`INSERT INTO "Idea" (id,"ownerId",title,"updatedAt") VALUES ($1,$2,$3,clock_timestamp())`,
        [randomUUID(), account.localUserId, title]);
    }
    const workspace = pool(primaryPort, 'primary_proof', 'fl_p6_workspace', workspacePassword);
    const prisma = new PrismaClient({ adapter: new PrismaPg(workspace), log: [], errorFormat: 'minimal' });
    try {
      const service = new WorkspaceService(new WorkspaceRepository(prisma), new WorkspaceCursor(randomBytes(32)), authority.authority);
      const first = await service.ideas(owner, { limit: 1 });
      assert.ok(first.page.nextCursor && first.items[0].title.startsWith('owned '));
      const second = await service.ideas(owner, { limit: 1, cursor: first.page.nextCursor });
      assert.ok(second.items[0].title.startsWith('owned ') && second.items[0].id !== first.items[0].id);
      assert.deepEqual((await service.ideas(foreign, {})).items.map(idea => idea.title), ['foreign']);
      assert.deepEqual(await service.ideas(empty, {}), { items: [], page: { hasMore: false, nextCursor: null } });
      await assert.rejects(service.ideas(foreign, { cursor: first.page.nextCursor }), { status: 400 });
      await workspaceTest.test('P8 restricted connection saves ordered USER turns without background work', async () => {
        const password = randomBytes(32).toString('hex');
        await primary.query(`CREATE ROLE fl_p8_conversations LOGIN NOINHERIT PASSWORD '${password}'`);
        await primary.query((await readFile('tests/fixtures/p8-conversation-grants.sql', 'utf8'))
          .replaceAll('founders_lens_p6_local', 'primary_proof'));
        const connection = pool(primaryPort, 'primary_proof', 'fl_p8_conversations', password);
        const client = new PrismaClient({ adapter: new PrismaPg(connection), log: [], errorFormat: 'minimal' });
        const verify = async () => Date.now() + 30_000;
        const key = randomBytes(32);
        const permissions = { read: verify, create: verify, save: verify };
        const operations = localConversationOperations(client, authority.authority, key, permissions);
        const ideaId = first.items[0].id;
        const rows = async () => (await primary.query(`SELECT
          (SELECT count(*)::int FROM "Conversation") AS conversations,(SELECT count(*)::int FROM "Message") AS messages,
          (SELECT count(*)::int FROM "GenerationAttempt") AS attempts,(SELECT count(*)::int FROM "UsageLedger") AS usage,
          (SELECT count(*)::int FROM "OutboxEvent") AS outbox,(SELECT count(*)::int FROM "IdempotencyRecord") AS receipts`)).rows[0];
        const before = await rows();
        const missing = { code: 'RESOURCE_NOT_FOUND' };
        try {
          assert.equal((await operations.idea(owner, ideaId)).id, ideaId);
          assert.deepEqual((await operations.conversations(owner, ideaId, {})).items, []);
          assert.deepEqual(await rows(), before);
          await assert.rejects(operations.idea(foreign, ideaId), missing);
          await assert.rejects(operations.create(foreign, ideaId, {}), missing);
          const conversation = await operations.create(owner, ideaId, { title: 'Disposable conversation' });
          assert.equal((await operations.conversation(owner, conversation.id)).ideaId, ideaId);
          assert.equal((await operations.conversations(owner, ideaId, {})).items[0].id, conversation.id);
          assert.deepEqual((await operations.history(owner, conversation.id, {})).items, []);
          await assert.rejects(operations.history(foreign, conversation.id, {}), missing);
          const input = { clientSubmissionId: randomUUID(), content: 'Disposable first user turn' };
          const [firstMessage, replay] = await Promise.all([1, 2].map(() => operations.save(owner, conversation.id, 'same-turn-key', input)));
          assert.deepEqual(firstMessage, replay);
          assert.equal(firstMessage.sequence, 1);
          await assert.rejects(operations.save(owner, conversation.id, 'same-turn-key', { ...input, content: 'Changed' }),
            { code: 'IDEMPOTENCY_KEY_REUSED' });
          // A receipt conflict cannot disclose its result once clearance expires during lookup.
          let deadline = Date.now() + 30_000;
          const clock = t.mock.method(Date, 'now', () => deadline - 1000);
          try {
            const slowReceipt = client.$extends({ query: { idempotencyRecord: { async findUnique({ args, query }) {
              const result = await query(args);
              clock.mock.mockImplementation(() => deadline);
              return result;
            } } } });
            const expiring = localConversationOperations(slowReceipt, authority.authority, key,
              { ...permissions, save: async () => deadline });
            await assert.rejects(expiring.save(owner, conversation.id, 'same-turn-key', { ...input, content: 'Changed' }),
              { code: 'DEPENDENCY_UNAVAILABLE' });
          } finally { clock.mock.restore(); }
          let verifications = 0;
          const changedAuthority = localConversationOperations(client, authority.authority, key, { ...permissions,
            save: async () => {
              if (++verifications === 2) throw new Error('Final authority verification failed');
              return verify();
            } });
          await assert.rejects(changedAuthority.save(owner, conversation.id, 'same-turn-key', { ...input, content: 'Changed' }),
            /Final authority verification failed/);
          await assert.rejects(operations.save(foreign, conversation.id, 'same-turn-key', input), missing);
          const secondMessage = await operations.save(owner, conversation.id, 'second-turn-key',
            { clientSubmissionId: randomUUID(), content: 'Disposable second user turn' });
          assert.equal(secondMessage.sequence, 2);
          const firstPage = await operations.history(owner, conversation.id, { limit: 1 });
          assert.deepEqual(firstPage.items, [firstMessage]);
          assert.deepEqual((await operations.history(owner, conversation.id, { limit: 1, cursor: firstPage.page.nextCursor })).items, [secondMessage]);
          const interrupted = client.$extends({ query: { idempotencyRecord: { create() { throw new Error('P8 receipt fault'); } } } });
          const failing = localConversationOperations(interrupted, authority.authority, key, permissions);
          await assert.rejects(failing.save(owner, conversation.id, 'interrupted-turn',
            { clientSubmissionId: randomUUID(), content: 'Rolled-back turn' }), /P8 receipt fault/);
          assert.equal((await primary.query('SELECT "nextSequence" FROM "Conversation" WHERE id=$1', [conversation.id])).rows[0].nextSequence, 3);
          assert.deepEqual(await rows(), { ...before, conversations: before.conversations + 1,
            messages: before.messages + 2, receipts: before.receipts + 2 });
          const unavailable = { code: 'DEPENDENCY_UNAVAILABLE' };
          const suppressed = localConversationOperations(client, { async lookup(scope, request) {
            const evidence = await authority.authority.lookup(scope, request);
            return scope.kind === 'IDEA' && evidence ? { ...evidence, verdict: 'SUPPRESSED' } : evidence;
          } }, key, permissions);
          await assert.rejects(suppressed.history(owner, conversation.id, {}), unavailable);
          await assert.rejects(suppressed.save(owner, conversation.id, 'same-turn-key', input), unavailable);
          const offline = localConversationOperations(client, { async lookup() { throw new Error('Authority unavailable'); } }, key, permissions);
          await assert.rejects(offline.history(owner, conversation.id, {}), unavailable);
          const locker = await primary.connect();
          try {
            await locker.query('BEGIN');
            await locker.query('SELECT id FROM "Conversation" WHERE id=$1 FOR UPDATE', [conversation.id]);
            let deadline = 0;
            const expiring = localConversationOperations(client, authority.authority, key,
              { ...permissions, save: async () => (deadline = Date.now() + 200) });
            const deniedSave = assert.rejects(expiring.save(owner, conversation.id, 'expired-turn',
              { clientSubmissionId: randomUUID(), content: 'Expired' }), unavailable);
            void deniedSave.catch(() => {});
            let waiting = false;
            for (let attempt = 0; attempt < 40 && !waiting; attempt++) {
              waiting = (await primary.query(`SELECT EXISTS (SELECT FROM pg_stat_activity
                WHERE usename='fl_p8_conversations' AND cardinality(pg_blocking_pids(pid)) > 0) AS waiting`)).rows[0].waiting;
              if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
            }
            assert.ok(waiting && deadline);
            await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now()) + 10));
            await locker.query('COMMIT');
            await deniedSave;
          } finally {
            try { await locker.query('ROLLBACK'); } finally { locker.release(); }
          }
          const deletionId = randomUUID();
          await primary.query(`INSERT INTO "DataOperation" (id,kind,"accountId","ideaId","deadlineAt","clerkInstanceId",
            "ownerSubjectKey","subjectKeyVersion","deletionScopeKey","deletionState","policyVersion")
            VALUES ($1,'DELETE_IDEA',$2,$3,now()+interval '1 minute',$4,$5,$6,$7,'DELETION_REQUESTED','p8-fixture')`,
          [deletionId, owner.localUserId, ideaId, owner.clerkInstanceId, owner.subjectKeys[0].digest, owner.subjectKeys[0].version, `idea:${ideaId}`]);
          try {
            await assert.rejects(operations.history(owner, conversation.id, {}), missing);
            await assert.rejects(operations.save(owner, conversation.id, 'same-turn-key', input), missing);
          } finally { await primary.query('DELETE FROM "DataOperation" WHERE id=$1', [deletionId]); }
          const tombstoneId = randomUUID();
          await primary.query(`INSERT INTO "IdentityTombstone" (id,"clerkInstanceId","subjectKey","subjectKeyVersion","requestedAt")
            VALUES ($1,$2,$3,$4,now())`, [tombstoneId, owner.clerkInstanceId, owner.subjectKeys[0].digest, owner.subjectKeys[0].version]);
          try {
            await assert.rejects(operations.history(owner, conversation.id, {}), { code: 'ACCOUNT_UNAVAILABLE' });
            await assert.rejects(operations.save(owner, conversation.id, 'same-turn-key', input), { code: 'ACCOUNT_UNAVAILABLE' });
          } finally { await primary.query('DELETE FROM "IdentityTombstone" WHERE id=$1', [tombstoneId]); }
          assert.deepEqual(await rows(), { ...before, conversations: before.conversations + 1,
            messages: before.messages + 2, receipts: before.receipts + 2 });
          for (const table of ['GenerationAttempt', 'UsageLedger', 'OutboxEvent']) {
            assert.equal((await connection.query('SELECT has_any_column_privilege(current_user,$1,\'INSERT\') AS allowed',
              [`public."${table}"`])).rows[0].allowed, false);
          }
        } finally { await client.$disconnect(); }
      });
      await workspaceTest.test('P7 restricted writer creates atomically and replays through the same account lock', async () => {
        const password = randomBytes(32).toString('hex');
        await primary.query(`CREATE ROLE fl_p7_idea_create LOGIN NOINHERIT PASSWORD '${password}'`);
        const rules = await readFile('tests/fixtures/p7-idea-create-grants.sql', 'utf8');
        await primary.query(rules.replaceAll('founders_lens_p6_local', 'primary_proof'));
        const writer = pool(primaryPort, 'primary_proof', 'fl_p7_idea_create', password);
        const writeClient = new PrismaClient({ adapter: new PrismaPg(writer), log: [{ emit: 'event', level: 'query' }], errorFormat: 'minimal' });
        const insertColumns = new Map();
        writeClient.$on('query', ({ query }) => {
          const insert = /INSERT INTO (?:"public"\.)?"(Idea|IdempotencyRecord)"\s*\(([^)]+)\)/.exec(query);
          if (insert) insertColumns.set(insert[1], insert[2].replaceAll('"', '').split(',').map(value => value.trim()).sort());
        });
        const writeService = new WorkspaceService(new WorkspaceRepository(writeClient), new WorkspaceCursor(randomBytes(32)), authority.authority);
        try {
          const input = { title: 'Disposable P7 idea', summary: 'Fixture text' };
          const verify = async () => Date.now() + 30_000;
          const [created, replay] = await Promise.all([1, 2].map(() => writeService.createIdea(owner, 'same-create-key', input, verify)));
          assert.deepEqual(created, replay);
          assert.deepEqual(insertColumns.get('Idea'), ['id','ownerId','title','summary','contextEpoch','status','version','createdAt','updatedAt'].sort());
          assert.deepEqual(insertColumns.get('IdempotencyRecord'), ['id','accountId','operationType','targetScope','key','requestFingerprint',
            'algorithmVersion','status','responseStatus','responseRef','createdAt','expiresAt'].sort());
          assert.ok((await service.ideas(owner, {})).items.some(idea => idea.id === created.id));
          assert.ok(!(await service.ideas(foreign, {})).items.some(idea => idea.id === created.id));
          await assert.rejects(writeService.createIdea(owner, 'same-create-key', { title: 'Changed' }, verify), { status: 409 });
          let checks = 0;
          await assert.rejects(writeService.createIdea(owner, 'lost-reply-key', input, async () => {
            if (++checks === 2) throw new Error('simulated clearance outage after commit');
            return verify();
          }), /outage after commit/);
          const recovered = await writeService.createIdea(owner, 'lost-reply-key', input, verify);
          assert.notEqual(recovered.id, created.id);
          await primary.query('UPDATE "IdempotencyRecord" SET "expiresAt"=now() WHERE key=$1', ['same-create-key']);
          const replacement = await writeService.createIdea(owner, 'same-create-key', input, verify);
          assert.notEqual(replacement.id, created.id);
          const { rows: [totals] } = await primary.query(`SELECT
            (SELECT count(*)::int FROM "Idea" WHERE "ownerId"=$1 AND title=$2) AS ideas,
            (SELECT count(*)::int FROM "IdempotencyRecord" WHERE "accountId"=$1 AND "operationType"='postIdeas') AS receipts`,
          [owner.localUserId, input.title]);
          assert.deepEqual(totals, { ideas: 3, receipts: 2 });
          await assert.rejects(writer.query('SELECT content FROM "Message"'), { code: '42501' });
          await assert.rejects(writer.query('UPDATE "Idea" SET title=title WHERE id=$1', [created.id]), { code: '42501' });
          await assert.rejects(writer.query('DELETE FROM "Idea" WHERE id=$1', [created.id]), { code: '42501' });
          await assert.rejects(writer.query('CREATE TABLE forbidden_p7 (id integer)'), { code: '42501' });
          await assert.rejects(new PrismaIdentityRepository(writeClient).resolveExisting({ instanceId: 'ins_fixture',
            subject: 'user_unbound' }, subjectKeys.derive('ins_fixture', 'user_unbound'), 1), { code: 'ACCOUNT_UNAVAILABLE' });
          await assert.rejects(writeService.createIdea({ ...owner, localUserId: foreign.localUserId }, 'foreign-owner-key', input, verify),
            { code: 'ACCOUNT_UNAVAILABLE' });
          const interrupted = writeClient.$extends({ query: { idempotencyRecord: { create() { throw new Error('receipt fault'); } } } });
          const interruptedService = new WorkspaceService(new WorkspaceRepository(interrupted), new WorkspaceCursor(randomBytes(32)), authority.authority);
          await assert.rejects(interruptedService.createIdea(owner, 'atomic-fault-key', { title: 'Uncommitted P7' }, verify), /receipt fault/);
          assert.equal((await primary.query('SELECT count(*)::int AS total FROM "Idea" WHERE title=$1', ['Uncommitted P7'])).rows[0].total, 0);
          const locker = await primary.connect();
          let expired;
          try {
            await locker.query('BEGIN');
            await locker.query('SELECT id FROM "UserAccount" WHERE id=$1 FOR UPDATE', [owner.localUserId]);
            let deadline;
            expired = assert.rejects(writeService.createIdea(owner, 'expires-under-lock', { title: 'Expired P7' },
              async () => (deadline = Date.now() + 200)), { code: 'DEPENDENCY_UNAVAILABLE' });
            void expired.catch(() => {});
            let waiting = false;
            for (let attempt = 0; attempt < 40 && !waiting; attempt++) {
              waiting = (await primary.query(`SELECT EXISTS (SELECT FROM pg_stat_activity
                WHERE usename='fl_p7_idea_create' AND cardinality(pg_blocking_pids(pid)) > 0) AS waiting`)).rows[0].waiting;
              if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
            }
            assert.ok(waiting && deadline, 'P7 creation did not wait on the account lock');
            await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now()) + 10));
            await locker.query('COMMIT');
            await expired;
          } finally {
            try { await locker.query('ROLLBACK'); } finally { locker.release(); }
          }
          assert.equal((await primary.query('SELECT count(*)::int AS total FROM "Idea" WHERE title=$1', ['Expired P7'])).rows[0].total, 0);
          await primary.query(`INSERT INTO "IdentityTombstone" (id,"clerkInstanceId","subjectKey","subjectKeyVersion","requestedAt")
            VALUES ($1,$2,$3,$4,now())`, [randomUUID(), foreign.clerkInstanceId, foreign.subjectKeys[0].digest, foreign.subjectKeys[0].version]);
          await assert.rejects(writeService.createIdea(foreign, 'tombstoned-create-key', input, verify), { code: 'ACCOUNT_UNAVAILABLE' });
          await primary.query(`INSERT INTO "DataOperation" (id,kind,"deadlineAt","clerkInstanceId","ownerSubjectKey",
            "subjectKeyVersion","deletionScopeKey","deletionState","policyVersion")
            VALUES ($1,'DELETE_ACCOUNT',now()+interval '1 minute',$2,$3,$4,$5,'DELETION_REQUESTED','p7-fixture')`,
          [randomUUID(), owner.clerkInstanceId, owner.subjectKeys[0].digest, owner.subjectKeys[0].version, `account:${randomUUID()}`]);
          await assert.rejects(writeService.createIdea(owner, 'same-create-key', input, verify), { code: 'ACCOUNT_UNAVAILABLE' });
        } finally { await writeClient.$disconnect(); }
      });
    } finally { await prisma.$disconnect(); }
  });

  await primary.query('CREATE DATABASE fresh_restore_target');
  const freshTarget = pool(primaryPort, 'fresh_restore_target', 'postgres', primaryPassword);
  await assert.rejects(guard(original, { primary: freshTarget }).assertClearance(), denied);
  await assert.rejects(guard({ ...original, authorityIdentity: '202:10' }).assertClearance(), denied);
  await assert.rejects(guard({ ...original, namespace }).assertClearance(), denied);
  await assert.rejects(guard(original, { subjectKeys: new SubjectKeys(2, new Map([[2, randomBytes(32)]])) })
    .assertClearance(), denied);

  // Losing part of inventory history keeps the same decision closed.
  await admin.query('UPDATE authority.inventory_count SET total=1');
  await assert.rejects(verifier.assertClearance(), denied);
  await admin.query('UPDATE authority.inventory_count SET total=0');
  const freezeId = randomUUID();
  const frozenEpoch = randomUUID();
  const freezeSeal = hmac(integrityKey, ['suppression-recovery-freeze-v1', frozenEpoch, pin, freezeId, primaryTarget, []]);
  await admin.query('UPDATE authority.coverage SET recovery_run=$1,recovery_target=$2,recovery_seal=$3,epoch=$4,integrity=$5',
    [freezeId, primaryTarget, freezeSeal, frozenEpoch, coverage(frozenEpoch)]);
  const thawedAuthority = createSuppressionLedger(reader, { ...trust, epoch: frozenEpoch });
  await assert.rejects(thawedAuthority.runtimeSnapshot(), /frozen for recovery/);
  await assert.rejects(guard({ ...original, epoch: frozenEpoch }, { authority: thawedAuthority }).assertClearance(), denied);
  await admin.query('UPDATE authority.coverage SET recovery_run=NULL,recovery_target=NULL,recovery_seal=NULL');
  await assert.rejects(verifier.assertClearance(), denied);
  const afterFreeze = guard(decisionFor(primaryTarget, await thawedAuthority.runtimeSnapshot()), { authority: thawedAuthority });
  await afterFreeze.assertClearance();

  // A real independently committed intent invalidates the earlier decision.
  const identity = { instanceId: 'ins_fixture', subject: 'user_fixture', sessionId: 'sess_fixture',
    expiresAt: Date.now() + 30_000 };
  const thawedAdmission = createSuppressionLedger(writer, { ...trust, epoch: frozenEpoch, challengeKey });
  await thawedAdmission.reserve({ operationId: randomUUID(), fingerprint: 'c'.repeat(64), policyVersion: 'fixture',
    scope: { kind: 'IDEA', instanceId: identity.instanceId, accountId: randomUUID(), ideaId: randomUUID() } },
  { identity, challengeId: 'fixture_challenge', validUntil: identity.expiresAt });
  await assert.rejects(afterFreeze.assertClearance(), denied);
  const next = guard(decisionFor(primaryTarget, await thawedAuthority.runtimeSnapshot()), { authority: thawedAuthority });
  await next.assertClearance();
  const changedEpoch = randomUUID();
  await admin.query('UPDATE authority.coverage SET epoch=$1,integrity=$2', [changedEpoch, coverage(changedEpoch)]);
  await assert.rejects(next.assertClearance(), denied);
  const currentAuthority = createSuppressionLedger(reader, { ...trust, epoch: changedEpoch });
  const current = guard(decisionFor(primaryTarget, await currentAuthority.runtimeSnapshot()), { authority: currentAuthority });
  await current.assertClearance();
  compose('stop', 'authority');
  await assert.rejects(current.assertClearance(), denied);
});
