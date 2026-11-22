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
  assert.deepEqual(Object.keys(verifier), ['assertClearance']);
  await verifier.assertClearance();
  await verifier.assertClearance();
  assert.equal(reads, 2);
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
