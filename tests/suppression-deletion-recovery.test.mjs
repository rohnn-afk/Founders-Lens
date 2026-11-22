// Live proof for the two-store commit boundary. Identity evidence is injected;
// Clerk signature and provider behavior are covered by the separate verifier suite.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import test from 'node:test';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../apps/api/dist/generated/prisma/client.js';
import { createDeletionAdmission } from '../apps/api/dist/privacy/deletion-admission.js';
import { createDeletionRecovery } from '../apps/api/dist/privacy/deletion-recovery.js';
import { createDeletionRepository } from '../apps/api/dist/privacy/deletion-repository.js';
import { createSuppressionLedger } from '../apps/api/dist/security/suppression-ledger.js';
import { SubjectKeys } from '../apps/api/dist/security/subject-key.js';

/** Obtain two ephemeral loopback ports before starting the dedicated project. */
async function testPorts() {
  const listeners = Array.from({ length: 2 }, () => createServer().listen(0, '127.0.0.1'));
  await Promise.all(listeners.map(server => once(server, 'listening')));
  const ports = listeners.map(server => server.address().port);
  await Promise.all(listeners.map(server => new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()))));
  return ports;
}

test('older PostgreSQL backup cannot reopen independently suppressed scopes', {
  skip: !process.argv.includes('--suppression-recovery-live'), timeout: 240_000
}, async t => {
  const [authorityPort, primaryPort] = await testPorts();
  const project = 'fl-suppression-deletion-' + randomUUID();
  const [adminPassword, readerPassword, writerPassword, primaryPassword, runtimePassword] =
    Array.from({ length: 5 }, () => randomBytes(32).toString('hex'));
  const env = { ...process.env,
    FL_SUPPRESSION_PORT: String(authorityPort), FL_SUPPRESSION_PRIMARY_PORT: String(primaryPort),
    FL_SUPPRESSION_ADMIN_PASSWORD: adminPassword, FL_SUPPRESSION_READER_PASSWORD: readerPassword,
    FL_SUPPRESSION_WRITER_PASSWORD: writerPassword, FL_SUPPRESSION_PRIMARY_PASSWORD: primaryPassword };
  const compose = (...args) => {
    const result = spawnSync('docker', ['compose', '-p', project, '-f',
      'tests/fixtures/suppression-ledger.compose.yaml', '--profile', 'rollback', ...args],
    { env, encoding: 'utf8', timeout: 70_000, windowsHide: true });
    assert.equal(result.status, 0, 'Isolated Compose command failed: ' + args[0]);
    return result.stdout.trim();
  };
  const pools = [];
  const connect = (port, database, user, password) => {
    const pool = new Pool({ host: '127.0.0.1', port, database, user, password,
      connectionTimeoutMillis: 800, statement_timeout: 1300, query_timeout: 1500 });
    pool.on('error', () => {});
    pools.push(pool);
    return pool;
  };
  let client;
  t.after(async () => {
    try {
      await client?.$disconnect();
      await Promise.all(pools.map(pool => pool.end()));
    } finally {
      compose('down', '--volumes');
      assert.equal(compose('ps', '-aq'), '');
    }
  });
  compose('up', '-d', '--wait', '--wait-timeout', '40');
  const admin = connect(authorityPort, 'suppression_proof', 'postgres', adminPassword);
  const writer = connect(authorityPort, 'suppression_proof', 'ledger_writer', writerPassword);
  const primary = connect(primaryPort, 'primary_proof', 'postgres', primaryPassword);
  await primary.query(await readFile('apps/api/prisma/migrations/0001_approved_baseline/migration.sql', 'utf8'));
  await primary.query(`CREATE ROLE deletion_runtime LOGIN NOINHERIT PASSWORD '${runtimePassword}';
    REVOKE CONNECT ON DATABASE primary_proof,postgres,template1 FROM PUBLIC;
    GRANT CONNECT ON DATABASE primary_proof TO deletion_runtime;
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    GRANT SELECT ON "DataOperation", "IdempotencyRecord" TO deletion_runtime;
    GRANT SELECT (id,status,"clerkSubject","clerkInstanceId","subjectKey","subjectKeyVersion"),
      UPDATE (status,"updatedAt") ON "UserAccount" TO deletion_runtime;
    GRANT SELECT (id,status,"ownerId","contextEpoch",version),
      UPDATE (status,"contextEpoch",version,"updatedAt") ON "Idea" TO deletion_runtime;
    GRANT SELECT (id,"ideaId") ON "Conversation" TO deletion_runtime;
    GRANT SELECT (id,"conversationId",status,"leaseEpoch"), UPDATE (status,"leaseEpoch","leaseUntil")
      ON "GenerationAttempt" TO deletion_runtime;
    GRANT SELECT (id,"ideaId",status,"leaseEpoch"), UPDATE (status,"leaseEpoch","leaseUntil","completedAt")
      ON "ResearchJob" TO deletion_runtime;
    GRANT UPDATE ("leaseEpoch","leaseUntil") ON "DataOperation" TO deletion_runtime;
    GRANT INSERT ON "DataOperation","IdempotencyRecord","IdentityTombstone","OutboxEvent" TO deletion_runtime;
    GRANT SELECT (id) ON "OutboxEvent" TO deletion_runtime`);
  const runtimePool = connect(primaryPort, 'primary_proof', 'deletion_runtime', runtimePassword);
  client = new PrismaClient({ adapter: new PrismaPg(runtimePool), errorFormat: 'minimal' });
  const epoch = randomUUID();
  const integrityKey = randomBytes(32);
  const challengeKey = randomBytes(32);
  const subjectVersions = [1, 2];
  const trusted = { epoch, integrityKey, challengeKey, subjectVersions };
  const hmac = (key, value) => createHmac('sha256', key).update(JSON.stringify(value)).digest('hex');
  const namespace = 'hmac-sha256-v1:' + hmac(challengeKey, ['deletion-challenge-namespace-v1']);
  const seal = hmac(integrityKey, ['suppression-coverage-v2', epoch, subjectVersions, namespace]);
  await admin.query('INSERT INTO authority.coverage VALUES(true,$1,$2,$3,$4)', [epoch, seal, subjectVersions, namespace]);
  const ledger = createSuppressionLedger(writer, trusted);
  const repository = createDeletionRepository(client);
  const identity = { instanceId: 'ins_test', subject: 'user_deletion', sessionId: 'sess_deletion',
    expiresAt: Date.now() + 120_000 };
  const subjectKeys = new SubjectKeys(2, new Map([[1, randomBytes(32)], [2, randomBytes(32)]]));
  const [old] = subjectKeys.derive(identity.instanceId, identity.subject);
  const accountId = randomUUID();
  const ideas = Array.from({ length: 4 }, () => randomUUID());
  await primary.query(`INSERT INTO "UserAccount"(id,"clerkSubject","clerkInstanceId","subjectKey","subjectKeyVersion","updatedAt")
    VALUES($1,$2,$3,$4,$5,now())`, [accountId, identity.subject, identity.instanceId, old.digest, old.version]);
  for (const idea of ideas) await primary.query('INSERT INTO "Idea"(id,"ownerId",title,"updatedAt") VALUES($1,$2,$3,now())', [idea, accountId, 'Synthetic']);
  const generation = randomUUID();
  const conversation = randomUUID();
  const message = randomUUID();
  await primary.query('INSERT INTO "Conversation"(id,"ideaId","updatedAt") VALUES($1,$2,now())', [conversation, ideas[2]]);
  await primary.query(`INSERT INTO "Message"(id,"ideaId","conversationId",sequence,role,content,"clientSubmissionKey","submissionSha256")
    VALUES($1,$2,$3,1,'USER','{}','fixture',$4)`, [message, ideas[2], conversation, 'a'.repeat(64)]);
  await primary.query(`INSERT INTO "GenerationAttempt"(id,"conversationId","triggerMessageId","attemptNumber",
    status,"contextEpoch","leaseEpoch","leaseUntil","deadlineAt")
    VALUES($1,$2,$3,1,'RUNNING',0,7,now()+interval '1 minute',now()+interval '2 minutes')`,
  [generation, conversation, message]);
  const policy = { version: 'p2d-privacy-v2', requireMfa: false, operationDeadlineMs: 60_000, receiptLifetimeMs: 60_000 };
  const command = (ideaId, idempotencyKey = randomUUID()) => ({
    ideaId, idempotencyKey, policyVersion: policy.version, confirmed: true });
  const evidence = { identity, challengeId: 'reverification_fixture', validUntil: identity.expiresAt };
  const composeAdmission = (overrides = {}) => createDeletionAdmission({
    clerk: { authenticate: async () => identity, verifyDeletionReverification: async () => evidence },
    provider: { assertLive: async () => {} }, subjectKeys, ledger, repository, policy, ...overrides
  });
  const call = (admit, value) => admit({}, [], value);
  const counts = async () => (await primary.query(`SELECT
    (SELECT count(*)::int FROM "DataOperation") AS operations,
    (SELECT count(*)::int FROM "OutboxEvent") AS outbox,
    (SELECT count(*)::int FROM "IdempotencyRecord") AS receipts`)).rows[0];

  // A second owner supplies the only candidate for post-recovery fixture access.
  const unaffected = { account: randomUUID(), idea: randomUUID(), subject: 'user_unaffected' };
  const [unaffectedKey] = subjectKeys.derive(identity.instanceId, unaffected.subject);
  await primary.query(`INSERT INTO "UserAccount"(id,"clerkSubject","clerkInstanceId","subjectKey","subjectKeyVersion","updatedAt")
    VALUES($1,$2,$3,$4,$5,now())`, [unaffected.account, unaffected.subject, identity.instanceId, unaffectedKey.digest, unaffectedKey.version]);
  await primary.query('INSERT INTO "Idea"(id,"ownerId",title,"updatedAt") VALUES($1,$2,\'Synthetic unaffected\',now())',
    [unaffected.idea, unaffected.account]);

  // Keep the backup inside the run-owned primary container. No production role
  // or connection is used. A new database OID identifies the restored target.
  const backup = '/tmp/fl-suppression-pre-deletion.dump';
  compose('exec', '-T', 'primary-proof', 'pg_dump', '-U', 'postgres', '-Fc', '-f', backup, 'primary_proof');
  const accepted = await call(composeAdmission(), command(null));
  assert.equal(accepted.status, 202);
  const pendingCommand = command(unaffected.idea);
  const pendingIdentity = { ...identity, subject: unaffected.subject, sessionId: 'sess_unaffected' };
  const pendingEvidence = { ...evidence, identity: pendingIdentity, challengeId: 'reverification_unresolved' };
  await primary.query(`CREATE FUNCTION reject_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected source rollback'; END $$;
    CREATE TRIGGER reject_outbox BEFORE INSERT ON "OutboxEvent" FOR EACH ROW EXECUTE FUNCTION reject_outbox()`);
  await assert.rejects(call(composeAdmission({ clerk: { authenticate: async () => pendingIdentity,
    verifyDeletionReverification: async () => pendingEvidence } }), pendingCommand));
  assert.deepEqual(await counts(), { operations: 1, outbox: 1, receipts: 1 });
  const originalInventory = await ledger.inventory();
  assert.equal(originalInventory.length, 2);
  const accountIntent = originalInventory.find(row => row.operation_id === accepted.operationId);
  assert.ok(accountIntent.incarnation_binding);
  assert.ok(!JSON.stringify(accountIntent).includes(accountId));
  assert.ok(ledger.matchesIncarnation(accountIntent, accountId));
  assert.ok(!ledger.matchesIncarnation(accountIntent, randomUUID()));

  compose('exec', '-T', 'primary-proof', 'createdb', '-U', 'postgres', 'restored_proof');
  compose('exec', '-T', 'primary-proof', 'pg_restore', '-U', 'postgres', '--exit-on-error',
    '-d', 'restored_proof', backup);
  const restored = connect(primaryPort, 'restored_proof', 'postgres', primaryPassword);
  const recoveryClient = new PrismaClient({ adapter: new PrismaPg(restored), errorFormat: 'minimal' });
  t.after(() => recoveryClient.$disconnect());
  const recovered = createDeletionRepository(recoveryClient);
  const cutoff = { runId: randomUUID(), target: await recovered.recoveryIdentity() };
  assert.notEqual(cutoff.target, await repository.recoveryIdentity());
  const recoveryEpoch = randomUUID();
  await admin.query(`CREATE ROLE recovery_runtime LOGIN NOINHERIT PASSWORD '${runtimePassword}';
    GRANT CONNECT ON DATABASE suppression_proof TO recovery_runtime;
    GRANT ledger_reconciler TO recovery_runtime WITH INHERIT TRUE`);
  const progress = connect(authorityPort, 'suppression_proof', 'recovery_runtime', runtimePassword);
  const recoveryLedger = createSuppressionLedger(progress, { epoch: recoveryEpoch, integrityKey, subjectVersions,
    challengeNamespace: namespace });
  const quarantine = async () => {
    // This proof project has only the two PostgreSQL services. No Redis,
    // application process, dispatcher or worker receives restored credentials.
    assert.deepEqual(compose('ps', '--services', '--status', 'running').split(/\r?\n/).sort(), ['authority', 'primary-proof']);
  };
  const gate = (overrides = {}) => createDeletionRecovery({ cutoff, repository: recovered,
    ledger: recoveryLedger, subjectKeys, assertIsolated: quarantine, operationDeadlineMs: 60_000, ...overrides });
  const coordinator = gate();
  const safeIdea = randomUUID();
  await restored.query('INSERT INTO "Idea"(id,"ownerId",title,"updatedAt") VALUES($1,$2,\'Synthetic safe\',now())',
    [safeIdea, unaffected.account]);
  await assert.rejects(coordinator.assertFixtureRead(unaffected.account, safeIdea));
  assert.equal((await restored.query('SELECT count(*)::int AS total FROM "DataOperation"')).rows[0].total, 0);
  assert.equal((await restored.query('SELECT status FROM "UserAccount" WHERE id=$1', [accountId])).rows[0].status, 'ACTIVE');

  // The operator takes the exclusive coverage-row lock before reading history.
  // Any in-flight writer holding the trigger's shared lock must drain first.
  const operator = await admin.connect();
  const inFlightWriter = await writer.connect();
  try {
    await inFlightWriter.query('BEGIN');
    await inFlightWriter.query(`INSERT INTO authority.intent(operation_id,scope_key,fingerprint,policy_version,
      integrity,challenge_key,reservation_epoch,reservation_namespace)
      VALUES($1,$2,$3,'proof',$3,$4,$5,$6)`, [randomUUID(),
      JSON.stringify(['IDEA', identity.instanceId, accountId, randomUUID()]), 'a'.repeat(64),
      'b'.repeat(64), epoch, namespace]);
    await operator.query('BEGIN');
    const [{ pid }] = (await operator.query('SELECT pg_backend_pid() AS pid')).rows;
    const freezeLock = operator.query('SELECT singleton FROM authority.coverage WHERE singleton FOR UPDATE');
    try {
      // PostgreSQL reports the operator blocked by the real insert's shared lock.
      let blocked = false;
      for (let attempt = 0; attempt < 20 && !blocked; attempt++) {
        blocked = (await admin.query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid])).rows[0].blocked;
      }
      assert.equal(blocked, true);
    } finally {
      await inFlightWriter.query('ROLLBACK');
      await freezeLock;
    }
    const rows = (await operator.query('SELECT integrity FROM authority.intent ORDER BY scope_key')).rows;
    const recoverySeal = hmac(integrityKey, ['suppression-recovery-freeze-v1', recoveryEpoch, namespace, cutoff.runId,
      cutoff.target, rows.map(row => row.integrity)]);
    const coverage = hmac(integrityKey, ['suppression-coverage-v2', recoveryEpoch, subjectVersions, namespace]);
    await operator.query(`UPDATE authority.coverage SET epoch=$1,integrity=$2,recovery_run=$3,recovery_target=$4,
      recovery_seal=$5 WHERE singleton`, [recoveryEpoch, coverage, cutoff.runId, cutoff.target, recoverySeal]);
    await operator.query('COMMIT');
  } finally { operator.release(); inFlightWriter.release(); }
  await assert.rejects(writer.query(`INSERT INTO authority.intent(operation_id,scope_key,fingerprint,policy_version,
    integrity,challenge_key,reservation_epoch,reservation_namespace)
    VALUES($1,$2,$3,'proof',$3,$4,$5,$6)`, [randomUUID(),
    JSON.stringify(['IDEA', identity.instanceId, accountId, randomUUID()]), 'a'.repeat(64),
    'b'.repeat(64), recoveryEpoch, namespace]), /coverage unavailable/);
  assert.deepEqual((await recoveryLedger.recoveryInventory(cutoff)).entries, originalInventory);
  await assert.rejects(ledger.inventory());
  await assert.rejects(gate({ cutoff: { ...cutoff, runId: randomUUID() } }).recover());
  await assert.rejects(gate({ repository }).recover());
  await assert.rejects(gate({ subjectKeys: new SubjectKeys(2, new Map([[2, randomBytes(32)]])) }).recover());
  await assert.rejects(progress.query('UPDATE authority.coverage SET recovery_run=NULL'), { code: '42501' });
  await assert.rejects(writer.query('INSERT INTO authority.recovery_progress VALUES($1,$2,$3)',
    [cutoff.runId, accepted.operationId, '0'.repeat(64)]), { code: '42501' });

  // A recreated account with an identical subject digest is not the original UUID.
  const replacement = randomUUID();
  await restored.query('UPDATE "UserAccount" SET "clerkSubject"=$2,"subjectKey"=$3 WHERE id=$1',
    [accountId, 'user_displaced', '0'.repeat(64)]);
  await restored.query(`INSERT INTO "UserAccount"(id,"clerkSubject","clerkInstanceId","subjectKey","subjectKeyVersion","updatedAt")
    VALUES($1,$2,$3,$4,$5,now())`, [replacement, identity.subject, identity.instanceId, old.digest, old.version]);
  await assert.rejects(coordinator.recover());
  assert.equal((await restored.query('SELECT status FROM "UserAccount" WHERE id=$1', [replacement])).rows[0].status, 'ACTIVE');
  await restored.query('DELETE FROM "UserAccount" WHERE id=$1', [replacement]);
  // Restore the original incarnation using a rotated local digest. The older
  // authority digest still has to match one of its retained key versions.
  const rotated = subjectKeys.derive(identity.instanceId, identity.subject).find(key => key.version === 2);
  await restored.query('UPDATE "UserAccount" SET "clerkSubject"=$2,"subjectKey"=$3,"subjectKeyVersion"=2 WHERE id=$1',
    [accountId, identity.subject, rotated.digest]);

  // Roll back late primary writes, then lose a durable commit acknowledgement
  // before progress append. A new coordinator must inspect and converge.
  await restored.query(`CREATE FUNCTION reject_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected restore rollback'; END $$;
    CREATE TRIGGER reject_outbox BEFORE INSERT ON "OutboxEvent" FOR EACH ROW EXECUTE FUNCTION reject_outbox()`);
  await assert.rejects(coordinator.recover());
  assert.equal((await restored.query('SELECT count(*)::int AS total FROM "DataOperation"')).rows[0].total, 0);
  await restored.query('DROP TRIGGER reject_outbox ON "OutboxEvent"');
  await assert.rejects(gate({ ledger: { ...recoveryLedger,
    recordRecovery: async () => { throw new Error('Injected crash before progress'); } } }).recover());
  assert.equal((await restored.query('SELECT count(*)::int AS total FROM "DataOperation"')).rows[0].total, 1);
  await assert.rejects(coordinator.assertFixtureRead(unaffected.account, safeIdea));

  await Promise.all([coordinator.recover(), gate().recover()]);
  await coordinator.assertFixtureRead(unaffected.account, safeIdea);
  await assert.rejects(coordinator.assertFixtureRead(unaffected.account, unaffected.idea));
  // An in-flight check from a previous opening cannot survive a new recovery,
  // even when the new run through reconciliation verifies the same inventory.
  const reading = Promise.withResolvers();
  const resumeRead = Promise.withResolvers();
  const barrierGate = gate({ repository: { ...recovered, async readFixtureScope(...args) {
    reading.resolve();
    await resumeRead.promise;
    return recovered.readFixtureScope(...args);
  } } });
  await barrierGate.recover();
  const staleRead = assert.rejects(barrierGate.assertFixtureRead(unaffected.account, safeIdea),
    { code: 'DEPENDENCY_UNAVAILABLE' });
  await reading.promise;
  try {
    await barrierGate.recover();
  } finally {
    resumeRead.resolve();
    await staleRead;
  }
  await barrierGate.assertFixtureRead(unaffected.account, safeIdea);
  assert.deepEqual((await restored.query(`SELECT
    (SELECT count(*)::int FROM "DataOperation") AS operations,
    (SELECT count(*)::int FROM "OutboxEvent") AS outbox,
    (SELECT count(*)::int FROM "IdempotencyRecord") AS receipts,
    (SELECT count(*)::int FROM "IdentityTombstone") AS tombstones`)).rows[0],
  { operations: 2, outbox: 2, receipts: 0, tombstones: 2 });
  assert.equal((await progress.query('SELECT count(*)::int AS total FROM authority.recovery_progress')).rows[0].total, 2);
  // Restored worker epochs cannot satisfy the post-recovery database fence.
  const staleWrite = await restored.query(`UPDATE "GenerationAttempt" g SET status='COMPLETED'
    FROM "Conversation" c JOIN "Idea" i ON i.id=c."ideaId"
    WHERE c.id=g."conversationId" AND g.id=$1 AND g.status='RUNNING'
      AND g."leaseEpoch"=7 AND i."contextEpoch"=0`, [generation]);
  assert.equal(staleWrite.rowCount, 0);
  assert.ok((await restored.query('SELECT "leaseEpoch" FROM "GenerationAttempt" WHERE id=$1', [generation])).rows[0].leaseEpoch > 7);

  compose('stop', 'authority');
  await assert.rejects(coordinator.assertFixtureRead(unaffected.account, safeIdea));
  compose('up', '-d', '--wait', '--wait-timeout', '40', 'authority');
  await assert.rejects(coordinator.assertFixtureRead(unaffected.account, safeIdea));
  await coordinator.recover();
  await restored.query('UPDATE "Idea" SET "ownerId"=$2 WHERE id=$1', [unaffected.idea, accountId]);
  await assert.rejects(coordinator.recover());
  await assert.rejects(coordinator.assertFixtureRead(unaffected.account, safeIdea));
  await restored.query('UPDATE "Idea" SET "ownerId"=$2 WHERE id=$1', [unaffected.idea, unaffected.account]);
  await coordinator.recover();
  await admin.query('DELETE FROM authority.recovery_progress WHERE operation_id=$1', [accepted.operationId]);
  await assert.rejects(coordinator.assertFixtureRead(unaffected.account, safeIdea));
  await coordinator.recover();
  await admin.query('UPDATE authority.intent SET integrity=$1 WHERE operation_id=$2', ['0'.repeat(64), accepted.operationId]);
  await assert.rejects(coordinator.assertFixtureRead(unaffected.account, safeIdea));
  await assert.rejects(coordinator.recover());
  await admin.query('DELETE FROM authority.recovery_progress WHERE operation_id=$1', [accepted.operationId]);
  await admin.query('DELETE FROM authority.intent WHERE operation_id=$1', [accepted.operationId]);
  await assert.rejects(recoveryLedger.recoveryInventory(cutoff), /inventory incomplete/);
});
