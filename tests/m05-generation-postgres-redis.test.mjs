// Opt-in T02 integration harness. Every write follows target and namespace
// verification and uses the restricted roles or the dedicated fixture queue.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readFileSync } from 'node:fs';
import { promisify, parseEnv } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { Queue, createIORedisClient } from 'bullmq';
import { generationRepository } from '../apps/worker/dist/generation-repository.js';
import { generationWorker } from '../apps/worker/dist/generation-worker.js';
import { generationConsumer } from '../apps/worker/dist/generation-consumer.js';
import { createGenerationRepository } from '../apps/api/dist/generation/repository.js';
import { createGenerationService } from '../apps/api/dist/generation/service.js';
import { suppressionScopeKey } from '../apps/api/dist/security/suppression-authority.js';
import { PrismaClient } from '../apps/api/dist/generated/prisma/client.js';

const { PrismaPg } = createRequire(new URL('../apps/api/package.json', import.meta.url))('@prisma/adapter-pg');
const runId = 'c4493052-1f5e-4060-8e40-700e374c3946';
const firstRun = 'ffb11ac8-505a-4094-bd89-8367450022e9';
const prefix = 'founders-lens-m05-t02-test-' + runId;
const database = 'founders_lens_m05_t02_test';
const checksum = '19fcf7f5f144d1ff39a00a489193392e9deaa60617ebe2f42a8ee576e203032b';
const roleName = role => 'fl_m05_t02_' + role;
const migration = 'apps/api/prisma/migrations/0001_approved_baseline/migration.sql';

function inspect(id, name, label, run, port, hostPort, image) {
  assert.match(id, /^[a-f0-9]{64}$/);
  let result;
  try {
    const format = '{{.Id}}|{{.Name}}|{{json .Config.Labels}}|{{json .HostConfig.PortBindings}}|{{.State.Status}}|{{.Config.Image}}';
    result = execFileSync('docker.exe',
      ['inspect', '--format', format, id], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('|');
  } catch (error) { throw new Error('Docker inspection failed: ' + (error.code ?? error.status)); }
  const [actualId, actualName, labels, bindings, status, actualImage] = result;
  assert.equal(actualId, id);
  assert.equal(actualName, '/' + name);
  assert.equal(JSON.parse(labels)[label], run);
  assert.deepEqual(JSON.parse(bindings), { [port]: [{ HostIp: '127.0.0.1', HostPort: hostPort }] });
  assert.equal(status, 'running');
  assert.equal(actualImage, image);
}

function target(env, role) {
  const url = new URL(env['M05_T02_' + role.toUpperCase() + '_DATABASE_URL']);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.host !== '127.0.0.1:55434' ||
    url.pathname !== '/' + database || url.username !== roleName(role) || !url.password ||
    url.search || url.hash) throw new Error('Unexpected T02 database target');
  return url.toString();
}

async function verify(db, role) {
  const { rows: [row] } = await db.query(`SELECT current_user AS role, current_database() AS database,
    shobj_description((SELECT oid FROM pg_database WHERE datname=current_database()),'pg_database') AS run,
    current_setting('server_version_num')::int/10000 AS version,
    has_column_privilege('public."Message"','content','SELECT') AS private,
    has_column_privilege('public."GenerationAttempt"','orchestrationMetadata','SELECT') AS metadata_read,
    has_column_privilege('public."GenerationAttempt"','orchestrationMetadata','UPDATE') AS metadata_write,
    has_column_privilege('public."GenerationAttempt"','status','UPDATE') AS transition,
    has_column_privilege('public."UsageLedger"','reservationState','UPDATE') AS settle,
    has_table_privilege('public."GenerationAttempt"','DELETE') AS clean,
    has_schema_privilege('public','CREATE') AS ddl,
    has_database_privilege('postgres','CONNECT') AS cross_db,
    (SELECT rolcanlogin FROM pg_roles WHERE rolname='fl_m05_t02_bootstrap') AS bootstrap,
    (SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname=current_user) AS admin`);
  assert.deepEqual(row, { role: roleName(role), database, run: 'isolated M05-T02 run ' + runId, version: 17,
    private: false, metadata_read: false, metadata_write: false,
    transition: role !== 'fixture', settle: role === 'worker', clean: role === 'fixture',
    ddl: false, cross_db: false, bootstrap: false, admin: false });
  for (const table of ['UserAccount', 'Idea', 'Conversation', 'GenerationAttempt']) {
    await db.query('SELECT id FROM "' + table + '" WHERE false FOR UPDATE');
  }
  if (role === 'worker') await db.query('SELECT id FROM "UsageLedger" WHERE false FOR UPDATE');
  const { rows: grants } = await db.query(`SELECT p.proname AS name,
    has_function_privilege(current_user,p.oid,'EXECUTE') AS execute FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='t02_receipts' ORDER BY p.proname`);
  assert.deepEqual(grants, [
    { name: 'fixture_sibling', execute: role === 'fixture' },
    ...['read_usage', 'record_usage'].map(name => ({ name, execute: role === 'worker' }))
  ]);
}

async function seed(db, fixtures) {
  const account = randomUUID(), idea = randomUUID(), conversation = randomUUID(), message = randomUUID(), generation = randomUUID();
  const subject = 'fixture-' + account, instance = 'm05-t02-fixture';
  const digest = createHash('sha256').update(subject).digest('hex');
  const scope = { account, idea, conversation, message, generation, instance, digest };
  fixtures.push(scope);
  await db.query('INSERT INTO "UserAccount" (id,"clerkSubject","clerkInstanceId","subjectKey","updatedAt") VALUES ($1,$2,$3,$4,now())',
    [account, subject, instance, digest]);
  await db.query('INSERT INTO "Idea" (id,"ownerId",title,"updatedAt") VALUES ($1,$2,\'Synthetic fixture\',now())', [idea, account]);
  await db.query('INSERT INTO "Conversation" (id,"ideaId","nextSequence","updatedAt") VALUES ($1,$2,2,now())', [conversation, idea]);
  await db.query(`INSERT INTO "Message" (id,"ideaId","conversationId",sequence,role,content,"clientSubmissionKey","submissionSha256")
    VALUES ($1,$2,$3,1,'USER','{"text":"fixture"}',$4,$5)`, [message, idea, conversation, randomUUID(), 'a'.repeat(64)]);
  await db.query(`INSERT INTO "GenerationAttempt" (id,"conversationId","triggerMessageId","attemptNumber","deadlineAt")
    VALUES ($1,$2,$3,1,now()+interval '120 seconds')`, [generation, conversation, message]);
  await db.query(`INSERT INTO "UsageLedger" (id,"accountId","reservationId","operationType",unit,"reservedUnits","measuredUnits","reconciliationKey")
    VALUES ($1,$2,$3,'generation','synthetic_unit',1,0,$4)`, [randomUUID(), account, generation, 'fixture:' + generation]);
  return { ...scope, principal: { localUserId: account, clerkSubject: subject, clerkInstanceId: instance,
    accountStatus: 'ACTIVE', subjectKeys: [{ version: 1, digest }] } };
}

async function clean(db, fixture) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM "OutboxEvent" WHERE "aggregateId" IN (SELECT id FROM "GenerationAttempt" WHERE "conversationId"=$1)',
      [fixture.conversation]);
    await client.query('DELETE FROM "IdempotencyRecord" WHERE "accountId"=$1', [fixture.account]);
    await client.query('DELETE FROM "UsageLedger" WHERE "accountId"=$1', [fixture.account]);
    await client.query('DELETE FROM "Message" WHERE "conversationId"=$1 AND role=\'ASSISTANT\'', [fixture.conversation]);
    await client.query('DELETE FROM "GenerationAttempt" WHERE "conversationId"=$1', [fixture.conversation]);
    for (const [table, id] of [['Message', fixture.message], ['Conversation', fixture.conversation],
      ['Idea', fixture.idea], ['UserAccount', fixture.account]]) await client.query('DELETE FROM "' + table + '" WHERE id=$1', [id]);
    await client.query('COMMIT');
  } finally { await client.query('ROLLBACK'); client.release(); }
}

async function namespace(redis) {
  const keys = [];
  let cursor = '0';
  do {
    const page = await redis.scan(cursor, 'MATCH', prefix + ':*', 'COUNT', 100);
    cursor = page[0];
    keys.push(...page[1]);
  } while (cursor !== '0');
  return keys;
}

test('restricted T02 PostgreSQL and Redis generation lifecycle', { skip: !process.argv.includes('--live'), timeout: 60_000 }, async t => {
  const env = parseEnv(readFileSync('.env.m05.t02.test', 'utf8'));
  const prior = parseEnv(readFileSync('.env.m05.test', 'utf8'));
  assert.equal(env.M05_T02_RUN_ID, runId);
  assert.equal(env.M05_T02_POSTGRES_CONTAINER_ID, '59d72d4e680e7cae6515ac0ac61d47c4f710c4cd35e146b63c5af1078747fd33');
  assert.equal(env.M05_T02_REDIS_CONTAINER_ID, 'b6642372eec06e04659ceef96aa3146e043df89f0e648cbfeaf0f8c8923530fc');
  assert.equal(env.M05_T02_REDIS_PREFIX, prefix);
  assert.equal(env.M05_T02_REDIS_CONTAINER_ID, prior.M05_REDIS_CONTAINER_ID);
  assert.equal(env.M05_T02_REDIS_SERVER_ID, prior.M05_REDIS_SERVER_ID);
  assert.equal(env.M05_T02_MIGRATION_SHA256, checksum);
  assert.equal(createHash('sha256').update(await promisify(readFile)(migration)).digest('hex'), checksum);
  inspect(env.M05_T02_POSTGRES_CONTAINER_ID, 'founders-lens-m05-t02-pg-' + runId, 'founders-lens.m05-t02-run', runId,
    '5432/tcp', '55434', 'docker.io/library/postgres:17.12-bookworm@sha256:40865bc877a289da75963d97d72b59633f639fc5af7a4e856bfa3714cae5b536');
  inspect(env.M05_T02_REDIS_CONTAINER_ID, 'founders-lens-m05-redis-' + firstRun, 'founders-lens.m05-run', firstRun,
    '6379/tcp', '56380', 'docker.io/library/redis:7.4.12-bookworm@sha256:2e3eb11462c4e3759e6972678dd051d150ff54b1e60714b3c33b701260172a90');
  const urls = Object.fromEntries(['worker', 'api', 'fixture'].map(role => [role, target(env, role)]));
  const dbs = Object.fromEntries(Object.entries(urls).map(([role, connectionString]) =>
    [role, new Pool({ connectionString, connectionTimeoutMillis: 1500, statement_timeout: 5000 })]));
  t.after(() => Promise.all(Object.values(dbs).map(db => db.end())));
  for (const [role, db] of Object.entries(dbs)) await verify(db, role);
  for (const table of ['UserAccount', 'Idea', 'Conversation', 'GenerationAttempt', 'Message', 'UsageLedger',
    'OutboxEvent', 'IdempotencyRecord']) {
    assert.equal((await dbs.fixture.query('SELECT id FROM "' + table + '" LIMIT 1')).rowCount, 0);
  }
  const tables = (await dbs.worker.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.map(row => row.tablename);
  const source = readFileSync(migration, 'utf8');
  assert.deepEqual(tables.sort(), ['_prisma_migrations', ...[...source.matchAll(/^CREATE TABLE "([^"]+)"/gm)].map(row => row[1])].sort());

  const redisUrl = new URL(prior.M05_REDIS_URL);
  if (redisUrl.protocol !== 'redis:' || redisUrl.host !== '127.0.0.1:56380' || redisUrl.pathname !== '/0' ||
    !/^[a-f0-9]{64}$/.test(redisUrl.password) || redisUrl.username || redisUrl.search || redisUrl.hash) {
    throw new Error('Unexpected T02 Redis target');
  }
  const redis = new Redis(redisUrl.toString(), { maxRetriesPerRequest: 0, retryStrategy: () => null, connectTimeout: 1500 });
  redis.on('error', () => {});
  let queue, consumer, owner = false;
  const fixtures = [], issued = new Set(), allowed = new Set();
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urls.api, statement_timeout: 5000 }) });
  try {
    const info = await redis.info('server');
    assert.equal(info.match(/^run_id:(\w+)/m)?.[1], env.M05_T02_REDIS_SERVER_ID);
    assert.deepEqual(await namespace(redis), []);
    owner = true;
    const workerRepo = generationRepository(dbs.worker);
    const worker = generationWorker(workerRepo, async (scope, query) => {
      if (!fixtures.some(f => [JSON.stringify(['ACCOUNT', f.instance, 1, f.digest, 'ALL']),
        JSON.stringify(['IDEA', f.instance, f.account, f.idea])].includes(scope))) return null;
      return { scope, nonce: query.nonce, verdict: 'CLEAR', observedAt: Date.now(), validUntil: Date.now() + 1500 };
    }, id => allowed.has(id));
    const authority = { async lookup(scope, query) {
      if (!fixtures.some(f => scope.instanceId === f.instance && (scope.kind === 'ACCOUNT'
        ? scope.subjectKey === f.digest : scope.ideaId === f.idea && scope.accountId === f.account))) return null;
      return { scope: suppressionScopeKey(scope), nonce: query.nonce, observedAt: Date.now(), validUntil: Date.now() + 1500,
        verdict: 'CLEAR', authority: 'INDEPENDENT', integrity: 'VERIFIED', coverage: 'COMPLETE', epoch: runId };
    } };
    const service = createGenerationService(createGenerationRepository(prisma, { operationType: 'generation',
      unit: 'synthetic_unit', quotaUnits: 2, receiptTtlMs: 60_000, deadlineMs: 120_000 }), authority);
    queue = new Queue('generation', { prefix, connection: createIORedisClient(redis) });
    queue.on('error', () => {});
    consumer = generationConsumer(redisUrl, prefix, worker);
    await consumer.waitUntilReady();

    async function deliver(id) {
      allowed.add(id);
      issued.add(id);
      const job = await queue.add('generation.requested', { generationId: id }, { jobId: id, attempts: 1,
        removeOnComplete: { age: 600, count: 100 }, removeOnFail: { age: 600, count: 100 } });
      for (let n = 0; n < 40; n++) {
        const state = await job.getState();
        if (state === 'completed') return;
        if (state === 'failed') throw new Error('The generation queue job failed');
        await sleep(100);
      }
      throw new Error('The generation queue job did not finish');
    }
    const status = (f, id = f.generation) => service.status(f.principal, id);
    const cancel = (f, key) => service.command(f.principal, { kind: 'cancel', target: f.generation, key });
    const usage = async id => (await dbs.fixture.query(
      'SELECT "reservationState","measuredUnits" FROM "UsageLedger" WHERE "reservationId"=$1', [id])).rows[0];
    const currentEvidenceExpiry = () => Date.now() + 1500;

    await t.test('broker finalization commits selection and usage, regeneration preserves then replaces it', async () => {
      const f = await seed(dbs.fixture, fixtures);
      assert.equal((await status(f)).status, 'PENDING');
      await deliver(f.generation);
      const first = await status(f);
      assert.equal(first.status, 'COMPLETED');
      assert.equal(first.selected, true);
      assert.ok(first.outputMessageId);
      assert.equal((await cancel(f, 'completed-first')).status, 200);
      const command = { kind: 'regenerate', key: 'regeneration-1', target: f.conversation, triggerMessageId: f.message };
      const accepted = await service.command(f.principal, command);
      assert.equal(accepted.body.status, 'PENDING');
      assert.equal((await status(f)).selected, true);
      assert.equal((await dbs.fixture.query('SELECT id FROM "OutboxEvent" WHERE "aggregateId"=$1 AND kind=\'generation.requested\'',
        [accepted.body.id])).rowCount, 1);
      await deliver(accepted.body.id);
      await deliver(accepted.body.id);
      assert.deepEqual(await service.command(f.principal, command), accepted);
      await assert.rejects(service.command(f.principal, { ...command, triggerMessageId: randomUUID() }),
        error => error.code === 'IDEMPOTENCY_KEY_REUSED');
      await assert.rejects(service.command(f.principal, { ...command, key: 'regeneration-2' }), error => error.code === 'QUOTA_EXCEEDED');
      assert.equal((await status(f)).selected, false);
      assert.equal((await status(f, accepted.body.id)).selected, true);
      for (const id of [f.generation, accepted.body.id]) {
        assert.deepEqual(await usage(id), { reservationState: 'SETTLED', measuredUnits: '1.00000' });
        assert.equal((await dbs.fixture.query('SELECT id FROM "Message" WHERE "generationAttemptId"=$1', [id])).rowCount, 1);
      }
    });

    await t.test('cancel before broker handoff is recoverable and replays the original acceptance', async () => {
      const f = await seed(dbs.fixture, fixtures);
      allowed.add(f.generation);
      const accepted = await cancel(f, 'cancel-before-job');
      assert.equal(accepted.body.status, 'CANCEL_REQUESTED');
      await worker.recover([f.generation]);
      assert.equal((await status(f)).status, 'CANCELLED');
      assert.deepEqual(await cancel(f, 'cancel-before-job'), accepted);
      assert.equal((await usage(f.generation)).reservationState, 'RELEASED');
    });

    await t.test('concurrent claims, crash takeover, stale writes and atomic insertion rollback', async () => {
      const f = await seed(dbs.fixture, fixtures);
      allowed.add(f.generation);
      const scope = await workerRepo.scope(f.generation);
      const claim = () => workerRepo.claim(scope, false, currentEvidenceExpiry());
      const leases = (await Promise.all([claim(), claim()])).filter(Boolean);
      assert.equal(leases.length, 1);
      const [stale] = leases;
      await dbs.fixture.query('UPDATE "GenerationAttempt" SET "leaseUntil"=now()-interval \'1 second\' WHERE id=$1', [f.generation]);
      const current = await workerRepo.claim(scope, true, currentEvidenceExpiry());
      assert.equal(current.epoch, stale.epoch + 1);
      assert.equal(await workerRepo.heartbeat(scope, stale.epoch), false);
      assert.equal(await workerRepo.finish(scope, stale.epoch, { id: randomUUID(), text: 'stale' }, currentEvidenceExpiry()), false);
      assert.equal(await workerRepo.markInvocation(scope, current.epoch, currentEvidenceExpiry()), true);
      assert.equal(await workerRepo.recordUsage(scope, current.epoch), true);
      await assert.rejects(workerRepo.finish(scope, current.epoch, { id: f.message, text: 'duplicate primary key' }, currentEvidenceExpiry()),
        /Generation transaction unavailable/);
      assert.equal((await status(f)).status, 'RUNNING');
      assert.equal((await usage(f.generation)).reservationState, 'RESERVED');
      assert.equal((await dbs.fixture.query('SELECT "nextSequence" FROM "Conversation" WHERE id=$1', [f.conversation])).rows[0].nextSequence, 2);
      await cancel(f, 'cancel-first');
      assert.equal(await workerRepo.finish(scope, current.epoch, { id: randomUUID(), text: 'discarded' }, currentEvidenceExpiry()), true);
      assert.equal((await status(f)).status, 'CANCELLED');
      assert.equal((await usage(f.generation)).measuredUnits, '1.00000');
    });

    await t.test('context changes fence output and inactive ideas stop access', async () => {
      const f = await seed(dbs.fixture, fixtures);
      const scope = await workerRepo.scope(f.generation);
      const lease = await workerRepo.claim(scope, false, currentEvidenceExpiry());
      await dbs.fixture.query('UPDATE "Idea" SET "contextEpoch"="contextEpoch"+1 WHERE id=$1', [f.idea]);
      assert.ok(!await workerRepo.finish(scope, lease.epoch, { id: randomUUID(), text: 'old context' }, currentEvidenceExpiry()));
      await dbs.fixture.query('UPDATE "GenerationAttempt" SET "leaseUntil"=now()-interval \'1 second\' WHERE id=$1', [f.generation]);
      allowed.add(f.generation);
      await worker.recover([f.generation]);
      assert.equal((await status(f)).status, 'FAILED');
      await dbs.fixture.query('UPDATE "Idea" SET status=\'ARCHIVED\' WHERE id=$1', [f.idea]);
      assert.equal(await workerRepo.scope(f.generation), undefined);
      await assert.rejects(cancel(f, 'archived-idea'), error => error.code === 'RESOURCE_NOT_FOUND');
    });

    await t.test('settlement failure rolls back assistant insertion and regeneration selection', async () => {
      const f = await seed(dbs.fixture, fixtures);
      await deliver(f.generation);
      const previous = await status(f);
      const accepted = await service.command(f.principal, { kind: 'regenerate', key: 'rollback-regeneration',
        target: f.conversation, triggerMessageId: f.message });
      const id = accepted.body.id;
      const scope = await workerRepo.scope(id);
      const lease = await workerRepo.claim(scope, false, currentEvidenceExpiry());
      assert.equal(await workerRepo.markInvocation(scope, lease.epoch, currentEvidenceExpiry()), true);
      assert.equal(await workerRepo.recordUsage(scope, lease.epoch), true);
      // Remove only this fixture's reservation to exercise rollback after
      // response insertion and the attempted switch of the selected result.
      await dbs.fixture.query('DELETE FROM "UsageLedger" WHERE "accountId"=$1 AND "reservationId"=$2', [f.account, id]);
      await assert.rejects(workerRepo.finish(scope, lease.epoch, { id: randomUUID(), text: 'uncommitted' }, currentEvidenceExpiry()),
        /Generation transaction unavailable/);
      assert.deepEqual(await status(f), previous);
      assert.equal((await status(f, id)).status, 'RUNNING');
      assert.equal((await dbs.fixture.query('SELECT id FROM "Message" WHERE "generationAttemptId"=$1', [id])).rowCount, 0);
      assert.equal((await dbs.fixture.query('SELECT "nextSequence" FROM "Conversation" WHERE id=$1', [f.conversation]))
        .rows[0].nextSequence, 3);
    });

    await t.test('last-claim expiry rolls back publication and concurrent recovery settles its receipt once', async () => {
      const f = await seed(dbs.fixture, fixtures);
      await deliver(f.generation);
      const previous = await status(f);
      const { body: { id } } = await service.command(f.principal, { kind: 'regenerate', key: 'expired-clearance',
        target: f.conversation, triggerMessageId: f.message });
      const sibling = async (account, seed) => (await dbs.fixture.query(
        'SELECT t02_receipts.fixture_sibling($1,$2,$3) AS verified', [id, account, seed])).rows[0].verified;
      assert.equal(await sibling(randomUUID(), true), false);
      assert.equal(await sibling(f.account, true), true);
      assert.equal(await sibling(f.account, true), false);
      for (const connection of [dbs.worker, dbs.api]) {
        await assert.rejects(connection.query('SELECT t02_receipts.fixture_sibling($1,$2,false)', [id, f.account]),
          { code: '42501' });
      }
      await assert.rejects(dbs.fixture.query('SELECT t02_receipts.read_usage($1)', [id]), { code: '42501' });
      await assert.rejects(dbs.fixture.query('SELECT t02_receipts.record_usage($1,1)', [id]), { code: '42501' });
      await assert.rejects(dbs.fixture.query('SELECT "orchestrationMetadata" FROM "GenerationAttempt" WHERE id=$1', [id]),
        { code: '42501' });
      const scope = await workerRepo.scope(id);
      const first = await workerRepo.claim(scope, false, currentEvidenceExpiry());
      await dbs.fixture.query('UPDATE "GenerationAttempt" SET "leaseUntil"=now()-interval \'1 second\' WHERE id=$1', [id]);
      const lease = await workerRepo.claim(scope, true, currentEvidenceExpiry());
      assert.equal(lease.epoch, first.epoch + 1);
      assert.equal(await workerRepo.markInvocation(scope, lease.epoch, currentEvidenceExpiry()), true);
      const fake = async () => 'successful synthetic output';
      const output = { id: randomUUID(), text: await fake() };
      assert.equal(await workerRepo.recordUsage(scope, first.epoch), false);
      assert.equal(await workerRepo.recordUsage(scope, lease.epoch), true);
      assert.equal(await workerRepo.recordUsage(scope, lease.epoch), true);
      assert.equal(await sibling(f.account, false), true);
      await assert.rejects(dbs.worker.query('SELECT "orchestrationMetadata" FROM "GenerationAttempt" WHERE id=$1', [id]),
        { code: '42501' });
      await assert.rejects(dbs.worker.query('UPDATE "GenerationAttempt" SET "orchestrationMetadata"=NULL WHERE id=$1', [id]),
        { code: '42501' });
      await assert.rejects(dbs.worker.query(`SELECT t02_receipts.record_usage($1,$2,'{"otherKey":1}'::jsonb)`,
        [id, lease.epoch]), { code: '42883' });
      const receiptReader = await dbs.worker.connect();
      try {
        await receiptReader.query('BEGIN');
        // Simulate a newer epoch without permanently changing the fixture.
        // A previous receipt remains readable but cannot be replaced.
        await receiptReader.query('UPDATE "GenerationAttempt" SET "leaseEpoch"="leaseEpoch"+1 WHERE id=$1', [id]);
        const { rows: [row] } = await receiptReader.query('SELECT t02_receipts.read_usage($1) AS receipt', [id]);
        assert.deepEqual(row.receipt, { version: 1, generationId: id, leaseEpoch: lease.epoch,
          measuredUnits: 1, completion: 'SUCCEEDED' });
        await assert.rejects(receiptReader.query('SELECT t02_receipts.record_usage($1,$2)', [id, lease.epoch + 1]),
          { code: '22023' });
      } finally {
        await receiptReader.query('ROLLBACK');
        receiptReader.release();
      }
      const blocker = await dbs.fixture.connect();
      let finalizing;
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM "Idea" WHERE id=$1 FOR UPDATE', [f.idea]);
        const { rows: [clock] } = await blocker.query(`SELECT pg_backend_pid() AS pid,
          floor(extract(epoch FROM clock_timestamp())*1000)::float8 AS milliseconds`);
        const expiry = clock.milliseconds + 800;
        finalizing = workerRepo.finish(scope, lease.epoch, output, expiry);
        let waiting = false;
        for (let check = 0; check < 30 && !waiting; check++) {
          const { rows: [lock] } = await dbs.worker.query(`SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity WHERE usename=current_user
            AND $1=ANY(pg_blocking_pids(pid))) AS waiting`, [clock.pid]);
          waiting = lock.waiting;
          if (!waiting) await sleep(10);
        }
        assert.ok(waiting, 'finalization must be waiting for the fixture row lock');
        const { rows: [timing] } = await blocker.query(`SELECT clock_timestamp()<to_timestamp($1::double precision/1000) AS current`, [expiry]);
        assert.ok(timing.current, 'clearance was still current while finalization was blocked');
        await blocker.query(`SELECT pg_sleep(greatest(0,$1::double precision/1000-extract(epoch FROM clock_timestamp())) + 0.05)`, [expiry]);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        if (finalizing) assert.equal(await finalizing, false);
      }

      assert.deepEqual(await status(f), previous);
      const attempt = await status(f, id);
      assert.equal(attempt.status, 'RUNNING');
      assert.equal(attempt.selected, false);
      assert.equal(attempt.outputMessageId, undefined);
      assert.deepEqual(await usage(id), { reservationState: 'RESERVED', measuredUnits: '0.00000' });
      assert.equal((await dbs.fixture.query('SELECT id FROM "Message" WHERE "generationAttemptId"=$1', [id])).rowCount, 0);
      await dbs.fixture.query('UPDATE "GenerationAttempt" SET "leaseUntil"=now()-interval \'1 second\' WHERE id=$1', [id]);
      assert.equal(await workerRepo.finish(scope, lease.epoch, output, currentEvidenceExpiry()), false);
      allowed.add(id);
      await Promise.all([worker.recover([id]), workerRepo.claim(scope, true, currentEvidenceExpiry())]);
      assert.equal((await status(f, id)).status, 'FAILED');
      await worker.recover([id]);
      assert.deepEqual(await usage(id), { reservationState: 'SETTLED', measuredUnits: '1.00000' });
      assert.deepEqual(await status(f), previous);
      assert.equal((await dbs.fixture.query('SELECT id FROM "Message" WHERE "generationAttemptId"=$1', [id])).rowCount, 0);
    });

    await t.test('lost delivery recovery exhausts two fake claims and preserves the previous selection', async () => {
      const f = await seed(dbs.fixture, fixtures);
      await deliver(f.generation);
      const previous = await status(f);
      const accepted = await service.command(f.principal, { kind: 'regenerate', key: 'exhausted-regeneration',
        target: f.conversation, triggerMessageId: f.message });
      const id = accepted.body.id;
      let invocations = 0;
      let allowFinalization = true;
      let denied = 0;
      const subject = JSON.stringify(['ACCOUNT', f.instance, 1, f.digest, 'ALL']);
      const idea = JSON.stringify(['IDEA', f.instance, f.account, f.idea]);
      const retryWorker = generationWorker(workerRepo, async (scope, { nonce }) => {
        if (scope !== subject && scope !== idea) return null;
        if (!allowFinalization) { denied++; return null; }
        return { scope, nonce, verdict: 'CLEAR', observedAt: Date.now(), validUntil: Date.now() + 1500 };
      }, candidate => candidate === id, async () => {
        invocations++;
        if (invocations === 1) allowFinalization = false;
        throw new Error('Synthetic execution failure');
      });
      await retryWorker.recover([id]);
      assert.ok(denied > 0);
      assert.equal((await status(f, id)).status, 'RUNNING');
      await dbs.fixture.query('UPDATE "GenerationAttempt" SET "leaseUntil"=now()-interval \'1 second\' WHERE id=$1', [id]);
      allowFinalization = true;
      await retryWorker.recover([id]);
      await retryWorker.recover([id]);
      assert.equal(invocations, 2);
      assert.equal((await status(f, id)).status, 'FAILED');
      assert.deepEqual(await status(f), previous);
      assert.equal((await dbs.fixture.query('SELECT id FROM "Message" WHERE "generationAttemptId"=$1', [id])).rowCount, 0);
      assert.deepEqual(await usage(id), { reservationState: 'RESERVED', measuredUnits: '0.00000' });
    });
  } finally {
    try {
      await consumer?.close();
      for (const id of issued) await queue.remove(id);
      await queue?.close();
      if (owner) {
        // Only the verified empty-at-start T02 queue's known metadata can be
        // removed here. An unexpected key stops cleanup at the Redis boundary.
        const known = new Set(['id', 'meta', 'events', 'stalled-check', 'marker'].map(key => prefix + ':generation:' + key));
        const keys = await namespace(redis);
        assert.ok(keys.every(key => known.has(key)));
        if (keys.length) await redis.del(...keys);
      }
    } finally {
      redis.disconnect();
      try { for (const fixture of fixtures) await clean(dbs.fixture, fixture); }
      finally { await prisma.$disconnect(); }
    }
  }
});
