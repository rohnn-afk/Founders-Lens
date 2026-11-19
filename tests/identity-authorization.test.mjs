import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { connection, settings } from '../apps/api/scripts/database.mjs';
import { createDatabaseClient } from '../apps/api/dist/persistence/client.js';
import { IdentityService } from '../apps/api/dist/security/identity-service.js';
import { PrismaIdentityRepository } from '../apps/api/dist/security/identity-repository.js';
import { ClerkIdentityProvider } from '../apps/api/dist/security/identity-provider.js';
import { SubjectKeys, subjectLock } from '../apps/api/dist/security/subject-key.js';
import { PrismaAuthorization, authorizeChild } from '../apps/api/dist/security/authorization.js';
import { securityFailure } from '../apps/api/dist/security/errors.js';
import { suppressionScopeKey } from '../apps/api/dist/security/suppression-authority.js';
import { unavailableSuppressionAuthority } from '../apps/api/dist/security/suppression-unavailable.js';

const live = process.argv.includes('--live');
const run = randomUUID().replaceAll('-', '');
const instance = 'ins_m02test_' + run;
const foreignInstance = 'ins_other_' + run;
const material = new Map([[1, randomBytes(32)], [2, randomBytes(32)]]);
const keys = new SubjectKeys(2, material);
const identity = (subject, instanceId = instance) => ({ instanceId, subject,
  sessionId: 'sess_m02test_' + run, expiresAt: Date.now() + 120_000 });
// Positive clearance exists only inside this synthetic test harness. It is not
// independent-authority evidence and is never available to application startup.
const syntheticAuthority = { async lookup(scope, query) {
  return { verdict: 'CLEAR', scope: suppressionScopeKey(scope), nonce: query.nonce,
    observedAt: Date.now(), validUntil: Date.now() + 1000, integrity: 'VERIFIED',
    coverage: 'COMPLETE', authority: 'INDEPENDENT', epoch: 'synthetic-test-only' };
} };
const liveProvider = { async assertLive(value) {
  assert.ok([instance, foreignInstance].includes(value.instanceId));
  assert.ok(value.subject.startsWith('user_m02test_'));
  assert.ok(value.sessionId.startsWith('sess_m02test_'));
} };
const denied = code => error => error?.code === code;
async function scenario(t, name, action) {
  let failure;
  await t.test(name, async () => { try { await action(); } catch (error) { failure = error; throw error; } });
  if (failure) throw new Error('Verification stopped after failed scenario; scoped cleanup follows.', { cause: failure });
}

test('provider liveness uses the verified subject/session and fails closed', async t => {
  const verified = identity('user_m02test_provider');
  function provider(userChanges = {}, sessionChanges = {}) {
    return new ClerkIdentityProvider({ users: { async getUser(subject) {
      assert.equal(subject, verified.subject);
      return { id: subject, banned: false, locked: false, ...userChanges };
    } }, sessions: { async getSession(sessionId) {
      assert.equal(sessionId, verified.sessionId);
      return { id: sessionId, userId: verified.subject, status: 'active', expireAt: Date.now() + 60_000, ...sessionChanges };
    } } });
  }
  await scenario(t, 'matching active user and session accepted without any real SDK calls', () => provider().assertLive(verified));
  for (const [name, user, session, code] of [
    ['wrong user', { id: 'user_foreign' }, {}, 'UNAUTHENTICATED'],
    ['wrong session subject', {}, { userId: 'user_foreign' }, 'UNAUTHENTICATED'],
    ['wrong session ID', {}, { id: 'sess_foreign' }, 'UNAUTHENTICATED'],
    ['revoked session', {}, { status: 'revoked' }, 'UNAUTHENTICATED'],
    ['expired session', {}, { expireAt: 0 }, 'UNAUTHENTICATED'],
    ['missing expiry', {}, { expireAt: undefined }, 'UNAUTHENTICATED'],
    ['banned user', { banned: true }, {}, 'ACCOUNT_UNAVAILABLE'],
    ['locked user', { locked: true }, {}, 'ACCOUNT_UNAVAILABLE']
  ]) await scenario(t, name, () => assert.rejects(provider(user, session).assertLive(verified), denied(code)));
  for (const [status, code] of [[404, 'UNAUTHENTICATED'], [429, 'DEPENDENCY_UNAVAILABLE'], [503, 'DEPENDENCY_UNAVAILABLE']]) {
    await scenario(t, 'provider HTTP ' + status, async () => {
      const unavailable = new ClerkIdentityProvider({ users: { async getUser() { throw Object.assign(new Error('private provider details'), { status }); } },
        sessions: { async getSession() { return {}; } } });
      await assert.rejects(unavailable.assertLive(verified), denied(code));
    });
  }
});

test('HMAC versions and subject locks are deterministic, scoped and independent of rotation', () => {
  const subject = 'user_m02test_keys';
  const old = new SubjectKeys(1, new Map([[1, material.get(1)]]));
  assert.equal(old.derive(instance, subject)[0].digest, keys.derive(instance, subject).find(key => key.version === 1).digest);
  assert.notEqual(keys.derive(instance, subject)[0].digest, keys.derive(foreignInstance, subject)[0].digest);
  assert.notEqual(keys.derive(instance, subject)[0].digest, keys.derive(instance, subject + '_other')[0].digest);
  assert.equal(subjectLock(instance, subject), instance + '\u001f' + subject);
  assert.throws(() => new SubjectKeys(3, material), denied('DEPENDENCY_UNAVAILABLE'));
  assert.throws(() => subjectLock(instance, 'user_bad\u001fsubject'), denied('UNAUTHENTICATED'));
});

test('real PostgreSQL identity and authorization foundation', { skip: !live, timeout: 120_000 }, async t => {
  const values = await settings();
  for (const key of ['TEST_DATABASE_URL', 'TEST_MIGRATION_DATABASE_URL']) {
    const url = new URL(values[key]);
    assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55432');
    assert.equal(url.pathname, '/founders_lens_m02_test');
  }
  const owner = connection(values.TEST_MIGRATION_DATABASE_URL);
  await owner.connect();
  const runtime = createDatabaseClient({ DATABASE_URL: values.TEST_DATABASE_URL });
  const subjects = [], tombstones = [], operations = [], ideas = [], conversations = [];
  const tables = ['UserAccount', 'IdentityTombstone', 'DataOperation', 'Idea', 'Conversation'];
  const counts = async () => {
    const result = {};
    for (const table of tables) result[table] = (await owner.query(`SELECT count(*)::int AS count FROM "${table}"`)).rows[0].count;
    return result;
  };
  const initial = await counts();
  const repository = new PrismaIdentityRepository(runtime);
  const service = (provider = liveProvider, ring = keys, repo = repository, instanceId = instance, authority = syntheticAuthority) =>
    new IdentityService(instanceId, ring, provider, repo, authority);
  async function subject() {
    const value = 'user_m02test_' + randomUUID().replaceAll('-', '');
    assert.equal((await owner.query('SELECT count(*)::int AS count FROM "UserAccount" WHERE "clerkSubject"=$1', [value])).rows[0].count, 0);
    subjects.push(value); return value;
  }
  async function provision(ring = keys) {
    const sub = await subject(); const principal = await service(liveProvider, ring).resolve(identity(sub), 'synthetic-request');
    return { sub, principal };
  }
  async function idea(principal) {
    const id = randomUUID(); ideas.push(id);
    await runtime.idea.create({ data: { id, ownerId: principal.localUserId, title: 'Synthetic private fixture ' + run } });
    return id;
  }
  async function tombstone(sub, version) {
    const key = keys.derive(instance, sub).find(key => key.version === version), id = randomUUID();
    tombstones.push(id);
    await owner.query('INSERT INTO "IdentityTombstone" (id,"clerkInstanceId","subjectKey","subjectKeyVersion","requestedAt") VALUES ($1,$2,$3,$4,now())', [id, instance, key.digest, key.version]);
  }
  async function deletion(sub) {
    const key = keys.derive(instance, sub)[0], id = randomUUID(); operations.push(id);
    await owner.query('INSERT INTO "DataOperation" (id,kind,"deadlineAt","clerkInstanceId","ownerSubjectKey","subjectKeyVersion","deletionScopeKey","deletionState","policyVersion") VALUES ($1,\'DELETE_ACCOUNT\',now()+interval \'1 minute\',$2,$3,$4,$5,\'DELETION_REQUESTED\',\'m02-synthetic\')',
      [id, instance, key.digest, key.version, 'account:synthetic:' + id]);
  }
  const authorization = new PrismaAuthorization(runtime, syntheticAuthority);
  try {
    await scenario(t, 'test target and runtime identity are restricted', async () => {
      const rows = await runtime.$queryRaw`SELECT current_user AS role, current_database() AS database`;
      assert.deepEqual(rows, [{ role: 'fl_m02_runtime', database: 'founders_lens_m02_test' }]);
    });
    await scenario(t, 'first provisioning and retries return one server-owned identity', async () => {
      const { sub, principal } = await provision();
      const again = await service().resolve(identity(sub), 'retry-request');
      assert.equal(again.localUserId, principal.localUserId);
      assert.equal(again.clerkSubject, sub); assert.equal(again.clerkInstanceId, instance);
      assert.equal((await owner.query('SELECT count(*)::int AS count FROM "UserAccount" WHERE "clerkSubject"=$1', [sub])).rows[0].count, 1);
    });
    await scenario(t, 'wrong instance and provider failure create no account', async () => {
      const sub = await subject(); let providerCalls = 0;
      const provider = { async assertLive() { providerCalls++; throw new Error('provider unavailable'); } };
      await assert.rejects(service(provider).resolve(identity(sub, foreignInstance), 'request'), denied('UNAUTHENTICATED'));
      assert.equal(providerCalls, 0);
      await assert.rejects(service(provider).resolve(identity(sub), 'request'), denied('DEPENDENCY_UNAVAILABLE'));
      await assert.rejects(service().resolve({ ...identity(sub), expiresAt: 0 }, 'request'), denied('UNAUTHENTICATED'));
      assert.equal((await owner.query('SELECT count(*)::int AS count FROM "UserAccount" WHERE "clerkSubject"=$1', [sub])).rows[0].count, 0);
    });
    await scenario(t, '20 independent connections wait on the approved subject lock and converge', async () => {
      const sub = await subject(), clients = Array.from({ length: 20 }, () => createDatabaseClient({ DATABASE_URL: values.TEST_DATABASE_URL }));
      let pending;
      await owner.query('BEGIN');
      try {
        await owner.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [subjectLock(instance, sub)]);
        pending = Promise.allSettled(clients.map(client => service(liveProvider, keys, new PrismaIdentityRepository(client)).resolve(identity(sub), 'concurrent-request')));
        let waiting = 0;
        const deadline = Date.now() + 3000;
        do {
          waiting = (await owner.query("SELECT count(*)::int AS count FROM pg_locks w JOIN pg_locks held ON w.locktype=held.locktype AND w.database=held.database AND w.classid=held.classid AND w.objid=held.objid AND w.objsubid=held.objsubid WHERE held.pid=pg_backend_pid() AND held.locktype='advisory' AND held.granted AND NOT w.granted")).rows[0].count;
          if (waiting === 20) break;
          await delay(25);
        } while (Date.now() < deadline);
        assert.equal(waiting, 20, 'All independent transactions must actually wait on the subject lock');
        assert.equal((await owner.query('SELECT count(*)::int AS count FROM "UserAccount" WHERE "clerkSubject"=$1', [sub])).rows[0].count, 0);
        await owner.query('COMMIT');
        const results = await pending;
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 20);
        assert.equal(new Set(results.map(result => result.value.localUserId)).size, 1);
        assert.equal((await owner.query('SELECT count(*)::int AS count FROM "UserAccount" WHERE "clerkSubject"=$1', [sub])).rows[0].count, 1);
      } finally {
        await owner.query('ROLLBACK'); if (pending) await pending;
        await Promise.all(clients.map(client => client.$disconnect()));
      }
    });
    await scenario(t, 'failure after account INSERT rolls back the real transaction', async () => {
      const sub = await subject(); let insertExecuted = false;
      const interrupted = runtime.$extends({ query: { userAccount: { async create({ args, query }) {
        await query(args); insertExecuted = true; throw new Error('synthetic failure after insertion');
      } } } });
      await assert.rejects(service(liveProvider, keys, new PrismaIdentityRepository(interrupted)).resolve(identity(sub), 'request'), denied('DEPENDENCY_UNAVAILABLE'));
      assert.equal(insertExecuted, true);
      assert.equal((await owner.query('SELECT count(*)::int AS count FROM "UserAccount" WHERE "clerkSubject"=$1', [sub])).rows[0].count, 0);
    });
    await scenario(t, 'retained HMAC tombstones prevent provisioning and recreation', async () => {
      for (const version of [1, 2]) {
        const sub = await subject(); await tombstone(sub, version);
        await assert.rejects(service().resolve(identity(sub), 'request'), denied('ACCOUNT_UNAVAILABLE'));
        assert.equal((await owner.query('SELECT count(*)::int AS count FROM "UserAccount" WHERE "clerkSubject"=$1', [sub])).rows[0].count, 0);
      }
    });
    await scenario(t, 'a tombstone committed while provisioning waits prevents account creation', async () => {
      const sub = await subject(); let pending;
      await owner.query('BEGIN');
      try {
        await owner.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [subjectLock(instance, sub)]);
        pending = service().resolve(identity(sub), 'racing-request').then(value => ({ value }), error => ({ error }));
        let waiting = 0;
        const deadline = Date.now() + 2500;
        do {
          waiting = (await owner.query("SELECT count(*)::int AS count FROM pg_locks w JOIN pg_locks held ON w.locktype=held.locktype AND w.database=held.database AND w.classid=held.classid AND w.objid=held.objid AND w.objsubid=held.objsubid WHERE held.pid=pg_backend_pid() AND held.locktype='advisory' AND held.granted AND NOT w.granted")).rows[0].count;
          if (waiting > 0) break;
          await delay(25);
        } while (Date.now() < deadline);
        assert.equal(waiting, 1);
        await tombstone(sub, 1);
        await owner.query('COMMIT');
        const result = await pending;
        assert.equal(result.error?.code, 'ACCOUNT_UNAVAILABLE');
        assert.equal((await owner.query('SELECT count(*)::int AS count FROM "UserAccount" WHERE "clerkSubject"=$1', [sub])).rows[0].count, 0);
      } finally { await owner.query('ROLLBACK'); if (pending) await pending; }
    });
    await scenario(t, 'HMAC rotation preserves the account and checks all retained keys', async () => {
      const old = new SubjectKeys(1, new Map([[1, material.get(1)]]));
      const { sub, principal } = await provision(old);
      const rotated = await service().resolve(identity(sub), 'request');
      assert.equal(rotated.localUserId, principal.localUserId);
      const row = (await owner.query('SELECT "subjectKeyVersion","subjectKey" FROM "UserAccount" WHERE id=$1', [principal.localUserId])).rows[0];
      assert.equal(row.subjectKeyVersion, 2);
      assert.equal(row.subjectKey, keys.derive(instance, sub).find(key => key.version === 2).digest);
      await tombstone(sub, 1);
      await assert.rejects(service().resolve(identity(sub), 'request'), denied('ACCOUNT_UNAVAILABLE'));
      await assert.rejects(authorization.idea(rotated, randomUUID()), denied('ACCOUNT_UNAVAILABLE'));
    });
    await scenario(t, 'existing identity cannot be relinked to another instance or unknown HMAC', async () => {
      const { sub, principal } = await provision();
      await assert.rejects(service(liveProvider, keys, repository, foreignInstance).resolve(identity(sub, foreignInstance), 'request'), denied('ACCOUNT_UNAVAILABLE'));
      assert.equal((await owner.query('SELECT "clerkInstanceId" FROM "UserAccount" WHERE id=$1', [principal.localUserId])).rows[0].clerkInstanceId, instance);
      await owner.query('UPDATE "UserAccount" SET "subjectKeyVersion"=99 WHERE id=$1', [principal.localUserId]);
      await assert.rejects(service().resolve(identity(sub), 'request'), denied('DEPENDENCY_UNAVAILABLE'));
    });
    await scenario(t, 'disabled and all deletion states deny mapping and previously issued principals', async () => {
      for (const status of ['DISABLED', 'DELETION_REQUESTED', 'PURGING', 'DELETED']) {
        const { sub, principal } = await provision(), target = await idea(principal);
        await owner.query('UPDATE "UserAccount" SET status=$1 WHERE id=$2', [status, principal.localUserId]);
        await assert.rejects(service().resolve(identity(sub), 'request'), denied('ACCOUNT_UNAVAILABLE'));
        await assert.rejects(authorization.idea(principal, target), error => {
          assert.equal(error.code, 'ACCOUNT_UNAVAILABLE');
          const failure = securityFailure(error, 'synthetic-request');
          assert.equal(failure.status, 403);
          assert.equal(failure.body.error.code, 'ACCOUNT_UNAVAILABLE');
          assert.ok(!JSON.stringify(failure).includes(sub));
          assert.ok(!JSON.stringify(failure).includes(target));
          return true;
        });
        assert.equal((await owner.query('SELECT status FROM "UserAccount" WHERE id=$1', [principal.localUserId])).rows[0].status, status);
      }
    });
    await scenario(t, 'retained account deletion receipt prevents provisioning without a tombstone', async () => {
      const sub = await subject(); await deletion(sub);
      await assert.rejects(service().resolve(identity(sub), 'request'), denied('ACCOUNT_UNAVAILABLE'));
      assert.equal((await owner.query('SELECT count(*)::int AS count FROM "UserAccount" WHERE "clerkSubject"=$1', [sub])).rows[0].count, 0);
      const existing = await provision(), target = await idea(existing.principal);
      await deletion(existing.sub);
      await assert.rejects(authorization.idea(existing.principal, target), denied('ACCOUNT_UNAVAILABLE'));
    });
    await scenario(t, 'founder/idea ownership and parent-child scope are enforced by real queries', async () => {
      const alice = await provision(), bob = await provision();
      const aliceIdea = await idea(alice.principal), aliceOtherIdea = await idea(alice.principal), bobIdea = await idea(bob.principal);
      const conversation = randomUUID(); conversations.push(conversation);
      await runtime.conversation.create({ data: { id: conversation, ideaId: aliceIdea } });
      assert.equal((await authorization.idea(alice.principal, aliceIdea)).id, aliceIdea);
      assert.equal((await authorization.conversation(alice.principal, aliceIdea, conversation)).id, conversation);
      const failures = [];
      for (const target of [bobIdea, randomUUID()]) {
        try { await authorization.idea(alice.principal, target); assert.fail('Foreign/missing scope unexpectedly allowed'); }
        catch (error) { assert.equal(error.code, 'RESOURCE_NOT_FOUND'); failures.push(securityFailure(error, 'same-request')); }
      }
      assert.deepEqual(failures[0], failures[1]); assert.equal(failures[0].status, 404);
      await assert.rejects(authorization.conversation(alice.principal, aliceOtherIdea, conversation), denied('RESOURCE_NOT_FOUND'));
      await assert.rejects(authorization.conversation(bob.principal, bobIdea, conversation), denied('RESOURCE_NOT_FOUND'));
      await assert.rejects(authorizeChild(alice.principal, { id: aliceIdea, ownerId: alice.principal.localUserId, status: 'ACTIVE' },
        { id: conversation, ideaId: bobIdea }, syntheticAuthority), denied('RESOURCE_NOT_FOUND'));
      // Simulate an untrusted owner-ID substitution while verified subject remains Alice.
      await assert.rejects(authorization.idea({ ...alice.principal, localUserId: bob.principal.localUserId }, bobIdea), denied('ACCOUNT_UNAVAILABLE'));
      const serialized = JSON.stringify(failures);
      for (const secret of [alice.sub, bob.sub, aliceIdea, bobIdea, run]) assert.ok(!serialized.includes(secret));
      await owner.query('UPDATE "Idea" SET status=\'DELETION_REQUESTED\' WHERE id=$1', [aliceIdea]);
      await assert.rejects(authorization.idea(alice.principal, aliceIdea), denied('RESOURCE_NOT_FOUND'));
    });
    await scenario(t, 'unavailable suppression blocks identity and metadata authorization', async () => {
      const sub = await subject();
      await assert.rejects(service(liveProvider, keys, repository, instance, unavailableSuppressionAuthority()).resolve(identity(sub), 'request'), denied('DEPENDENCY_UNAVAILABLE'));
      assert.equal((await owner.query('SELECT count(*)::int AS count FROM "UserAccount" WHERE "clerkSubject"=$1', [sub])).rows[0].count, 0);
      const { principal } = await provision(), target = await idea(principal);
      await assert.rejects(new PrismaAuthorization(runtime, unavailableSuppressionAuthority()).idea(principal, target), denied('DEPENDENCY_UNAVAILABLE'));
    });
  } finally {
    await runtime.$disconnect();
    await owner.query('ROLLBACK');
    // Reviewed cleanup: only UUIDs and exact subjects registered by this run,
    // in dependency order. No wildcard DELETE, TRUNCATE, reset, DDL or purge.
    await owner.query('BEGIN');
    try {
      for (const [table, ids] of [['Conversation', conversations], ['Idea', ideas], ['DataOperation', operations], ['IdentityTombstone', tombstones]]) {
        if (!ids.length) continue;
        if (table === 'Conversation') await owner.query('DELETE FROM "Conversation" WHERE id=ANY($1::uuid[]) AND "ideaId" IN (SELECT i.id FROM "Idea" i JOIN "UserAccount" u ON u.id=i."ownerId" WHERE u."clerkSubject"=ANY($2::text[]) AND u."clerkInstanceId"=$3)', [ids, subjects, instance]);
        else if (table === 'Idea') await owner.query('DELETE FROM "Idea" WHERE id=ANY($1::uuid[]) AND "ownerId" IN (SELECT id FROM "UserAccount" WHERE "clerkSubject"=ANY($2::text[]) AND "clerkInstanceId"=$3)', [ids, subjects, instance]);
        else await owner.query(`DELETE FROM "${table}" WHERE id=ANY($1::uuid[]) AND "clerkInstanceId"=$2`, [ids, instance]);
      }
      if (subjects.length) await owner.query('DELETE FROM "UserAccount" WHERE "clerkSubject"=ANY($1::text[]) AND "clerkInstanceId"=ANY($2::text[])', [subjects, [instance, foreignInstance]]);
      await owner.query('COMMIT');
      assert.deepEqual(await counts(), initial, 'Fixture cleanup must preserve pre-existing table counts');
    } catch (error) { await owner.query('ROLLBACK'); throw error; }
    finally { await owner.end(); }
  }
});
