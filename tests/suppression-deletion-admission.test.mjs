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
import { createDeletionRepository } from '../apps/api/dist/privacy/deletion-repository.js';
import { createSuppressionLedger } from '../apps/api/dist/security/suppression-ledger.js';
import { requireClearance } from '../apps/api/dist/security/suppression-authority.js';
import { SecurityError } from '../apps/api/dist/security/errors.js';
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

test('authority challenge uniqueness precedes guarded primary deletion admission', {
  skip: !process.argv.includes('--suppression-deletion-live'), timeout: 240_000
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
  const reader = connect(authorityPort, 'suppression_proof', 'ledger_reader', readerPassword);
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
  const lookup = createSuppressionLedger(reader, { epoch, integrityKey, subjectVersions, challengeNamespace: namespace });
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
  const scope = ideaId => ({ kind: 'IDEA', instanceId: identity.instanceId, accountId, ideaId });
  const counts = async () => (await primary.query(`SELECT
    (SELECT count(*)::int FROM "DataOperation") AS operations,
    (SELECT count(*)::int FROM "OutboxEvent") AS outbox,
    (SELECT count(*)::int FROM "IdempotencyRecord") AS receipts`)).rows[0];

  // Fault after local writes, so this exercises rollback of the real transaction.
  await primary.query(`CREATE FUNCTION reject_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected rollback'; END $$;
    CREATE TRIGGER reject_outbox BEFORE INSERT ON "OutboxEvent" FOR EACH ROW EXECUTE FUNCTION reject_outbox()`);
  const [first, second] = ideas.slice(0, 2).map(idea => command(idea));
  const admission = composeAdmission();
  await Promise.all([assert.rejects(call(admission, first)), assert.rejects(call(admission, second))]);
  const inventory = await lookup.inventory();
  assert.equal(inventory.length, 1);
  const winner = inventory[0].scope_key.endsWith(first.ideaId + '"]') ? first : second;
  const loser = winner === first ? second : first;
  await assert.rejects(requireClearance(lookup.authority, scope(winner.ideaId)));
  await requireClearance(lookup.authority, scope(loser.ideaId));
  assert.deepEqual(await counts(), { operations: 0, outbox: 0, receipts: 0 });
  assert.equal((await primary.query('SELECT count(*)::int AS total FROM "Idea" WHERE status=\'ACTIVE\'')).rows[0].total, ideas.length);

  await primary.query('DROP TRIGGER reject_outbox ON "OutboxEvent"');
  const [accepted, duplicate] = await Promise.all([call(admission, winner), call(admission, winner)]);
  assert.deepEqual(accepted, { status: 202, operationId: inventory[0].operation_id });
  assert.deepEqual(duplicate, accepted);
  await assert.rejects(call(admission, { ...winner, idempotencyKey: randomUUID() }));
  await assert.rejects(call(admission, loser));
  const replayOnly = composeAdmission({ clerk: { authenticate: async () => identity,
    verifyDeletionReverification: async () => { throw Error('Committed replay must not require a new challenge'); } } });
  assert.deepEqual(await call(replayOnly, winner), accepted);
  assert.deepEqual(await counts(), { operations: 1, outbox: 1, receipts: 1 });

  // A stale seal, mismatched key or unverified caller cannot add any authority intent.
  const target = command(ideas[2]);
  const newChallenge = { authenticate: async () => identity,
    verifyDeletionReverification: async () => ({ ...evidence, challengeId: 'new_fixture' }) };
  for (const badLedger of [createSuppressionLedger(writer, { ...trusted, epoch: randomUUID() }),
    createSuppressionLedger(writer, { ...trusted, challengeKey: randomBytes(32) }),
    createSuppressionLedger(writer, { ...trusted, subjectVersions: [2] })]) {
    await assert.rejects(call(composeAdmission({ clerk: newChallenge, ledger: badLedger }), target));
  }
  await assert.rejects(call(composeAdmission({ clerk: { ...newChallenge,
    verifyDeletionReverification: async () => { throw new SecurityError('UNAUTHENTICATED'); } } }), target));
  await assert.rejects(call(composeAdmission({ clerk: { ...newChallenge,
    verifyDeletionReverification: async () => ({ ...evidence, validUntil: Date.now() - 1 }) } }), target));
  await assert.rejects(call(admission, command(randomUUID())));
  assert.equal((await lookup.inventory()).length, 1);
  await assert.rejects(writer.query('UPDATE authority.coverage SET challenge_namespace=NULL'), { code: '42501' });

  // Lost authority acknowledgement is injected after the actual insert returns.
  const query = writer.query.bind(writer);
  let dropReply = true;
  writer.query = async (...args) => {
    const result = await query(...args);
    if (dropReply && args[0]?.text?.startsWith('INSERT INTO authority.intent')) {
      dropReply = false;
      throw new Error('Injected authority response loss');
    }
    return result;
  };
  await call(composeAdmission({ clerk: newChallenge }), target);
  assert.equal(dropReply, false);
  assert.deepEqual((await primary.query('SELECT status,"leaseEpoch","leaseUntil" FROM "GenerationAttempt" WHERE id=$1',
    [generation])).rows[0], { status: 'CANCEL_REQUESTED', leaseEpoch: 8, leaseUntil: null });
  assert.equal((await primary.query('SELECT "contextEpoch" FROM "Idea" WHERE id=$1', [target.ideaId])).rows[0].contextEpoch, 1);
  assert.deepEqual(await counts(), { operations: 2, outbox: 2, receipts: 2 });

  const accountChallenge = { ...newChallenge,
    verifyDeletionReverification: async () => ({ ...evidence, challengeId: 'account_fixture' }) };
  const accountCommand = command(null);
  const tx = await admin.connect();
  try {
    await tx.query('BEGIN');
    await tx.query('LOCK TABLE authority.intent IN ACCESS EXCLUSIVE MODE');
    await assert.rejects(call(composeAdmission({ clerk: accountChallenge }), accountCommand));
    await tx.query('ROLLBACK');
  } finally { tx.release(); }
  compose('stop', 'authority');
  await assert.rejects(call(composeAdmission({ clerk: accountChallenge }), accountCommand));
  assert.deepEqual(await counts(), { operations: 2, outbox: 2, receipts: 2 });
  compose('up', '-d', '--wait', '--wait-timeout', '40', 'authority');
  // Expire the primary proof during a late write. The second database-clock
  // check must roll back even the outbox, while retaining the authority intent.
  await primary.query(`CREATE FUNCTION delay_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_sleep(0.6); RETURN NEW; END $$;
    CREATE TRIGGER delay_outbox BEFORE INSERT ON "OutboxEvent" FOR EACH ROW EXECUTE FUNCTION delay_outbox()`);
  const shortPrimaryProof = { ...repository,
    commit: (target, reservation, validUntil, deadline, expiry) =>
      repository.commit(target, reservation, Math.min(validUntil, Date.now() + 300), deadline, expiry) };
  await assert.rejects(call(composeAdmission({ clerk: accountChallenge, repository: shortPrimaryProof }), accountCommand),
    error => error.code === 'UNAUTHENTICATED');
  assert.deepEqual(await counts(), { operations: 2, outbox: 2, receipts: 2 });
  await assert.rejects(requireClearance(lookup.authority, { kind: 'ACCOUNT', instanceId: identity.instanceId,
    subjectKey: old.digest, subjectKeyVersion: old.version, incarnation: 'ALL' }));
  await primary.query('DROP TRIGGER delay_outbox ON "OutboxEvent"');
  await call(composeAdmission({ clerk: accountChallenge }), accountCommand);
  assert.equal((await primary.query('SELECT count(*)::int AS total FROM "IdentityTombstone"')).rows[0].total, 2);
  assert.equal((await primary.query('SELECT status FROM "UserAccount" WHERE id=$1', [accountId])).rows[0].status, 'DELETION_REQUESTED');
  await assert.rejects(requireClearance(lookup.authority, { kind: 'ACCOUNT', instanceId: identity.instanceId,
    subjectKey: old.digest, subjectKeyVersion: old.version, incarnation: 'ALL' }));
  assert.deepEqual(await counts(), { operations: 3, outbox: 3, receipts: 3 });
});
