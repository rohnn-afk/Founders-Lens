// Opt-in HTTP integration composition. Owns disposable Docker resources and
// joins the API, dispatcher and worker through their real persistence adapters.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { Queue, createIORedisClient } from 'bullmq';
import { PrismaClient } from '../apps/api/dist/generated/prisma/client.js';
import { createSubmissionRepository } from '../apps/api/dist/submission/repository.js';
import { createSubmissionService } from '../apps/api/dist/submission/service.js';
import { submissionRoutes } from '../apps/api/dist/submission/routes.js';
import { createGenerationRepository } from '../apps/api/dist/generation/repository.js';
import { createGenerationService } from '../apps/api/dist/generation/service.js';
import { generationRoutes } from '../apps/api/dist/generation/routes.js';
import { suppressionScopeKey } from '../apps/api/dist/security/suppression-authority.js';
import { dispatcher } from '../apps/dispatcher/dist/dispatch.js';
import { outboxRepository } from '../apps/dispatcher/dist/outbox-repository.js';
import { generationQueue } from '../apps/dispatcher/dist/generation-queue.js';
import { generationRepository } from '../apps/worker/dist/generation-repository.js';
import { generationWorker } from '../apps/worker/dist/generation-worker.js';
import { generationConsumer } from '../apps/worker/dist/generation-consumer.js';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const express = require('express');
const { PrismaPg } = require('@prisma/adapter-pg');
const label = 'founders-lens.m05-e2e-run';
const database = 'founders_lens_m05_e2e_test';
const pgImage = 'docker.io/library/postgres:17.12-bookworm@sha256:40865bc877a289da75963d97d72b59633f639fc5af7a4e856bfa3714cae5b536';
const redisImage = 'docker.io/library/redis:7.4.12-bookworm@sha256:2e3eb11462c4e3759e6972678dd051d150ff54b1e60714b3c33b701260172a90';
const checksum = '19fcf7f5f144d1ff39a00a489193392e9deaa60617ebe2f42a8ee576e203032b';
const roles = { api: 'fl_m05_t02_api', worker: 'fl_m05_t02_worker', fixture: 'fl_m05_t02_fixture', dispatch: 'fl_m05_e2e_dispatcher' };
const policy = { operationType: 'generation', unit: 'synthetic_unit', reservationUnits: 1,
  quotaUnits: 5, deadlineMs: 120_000, receiptTtlMs: 120_000 };
const secret = () => randomBytes(32).toString('hex');

function docker(args, input) {
  try {
    return execFileSync('docker', args, { input, encoding: 'utf8', windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch { throw new Error('Isolated Docker operation failed: ' + args[0]); }
}

function inspect(id, run, resource, binding, image) {
  const shape = '{{.Id}}|{{.Name}}|{{.Config.Image}}|{{json .Config.Labels}}|{{json .HostConfig.PortBindings}}|{{json .Mounts}}';
  const [actual, name, actualImage, labels, ports, mounts] = docker(['inspect', '--format', shape, id]).split('|');
  assert.deepEqual([actual, name, actualImage, JSON.parse(labels)[label], JSON.parse(ports), JSON.parse(mounts)],
    [id, '/m05-e2e-' + run + '-' + resource, image, run, binding, []]);
}

async function until(check) {
  for (let n = 0; n < 80; n++) {
    const result = await check();
    if (result) return result;
    await sleep(100);
  }
  throw new Error('Timed out waiting for isolated integration state');
}

async function postgres(id, run, credentials) {
  const migration = await readFile('apps/api/prisma/migrations/0001_approved_baseline/migration.sql');
  assert.equal(createHash('sha256').update(migration).digest('hex'), checksum);
  const adminUrl = 'postgresql://bootstrap:' + credentials.bootstrap + '@127.0.0.1:55435/' + database;
  const admin = new Pool({ connectionString: adminUrl, connectionTimeoutMillis: 300, max: 1 });
  try {
    await until(() => admin.query('SELECT 1').catch(() => false));
    const { rows: [identity] } = await admin.query(`SELECT current_database() AS db, current_user AS role,
      current_setting('server_version_num')::int/10000 AS major`);
    assert.deepEqual(identity, { db: database, role: 'bootstrap', major: 17 });
    await admin.query('BEGIN');
    try {
      await admin.query(migration.toString());
      await admin.query(`CREATE TABLE "_prisma_migrations" (id varchar(36) primary key, checksum varchar(64) not null,
        finished_at timestamptz, migration_name varchar(255) not null, logs text, rolled_back_at timestamptz,
        started_at timestamptz not null default now(), applied_steps_count integer not null default 0)`);
      await admin.query('INSERT INTO "_prisma_migrations" (id,checksum,migration_name,finished_at,applied_steps_count) VALUES ($1,$2,$3,now(),1)',
        [randomUUID(), checksum, '0001_approved_baseline']);
      // Identifiers are fixed and generated secrets are hex, never caller input.
      await admin.query(`COMMENT ON DATABASE ${database} IS 'isolated M05-E2E run ${run}';
        REVOKE CONNECT ON DATABASE postgres,template1,${database} FROM PUBLIC`);
      for (const [key, role] of Object.entries(roles)) {
        await admin.query(`CREATE ROLE ${role} LOGIN NOINHERIT PASSWORD '${credentials[key]}';
          GRANT CONNECT ON DATABASE ${database} TO ${role}`);
      }
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    }
    await admin.query(await readFile('tests/m05-local-generation-grants.sql', 'utf8'));
    await admin.query(await readFile('tests/m05-t02-bootstrap.sql', 'utf8'));
    assert.equal((await admin.query('SELECT checksum FROM "_prisma_migrations"')).rows[0].checksum, checksum);
    await admin.query('ALTER ROLE bootstrap NOLOGIN PASSWORD NULL');
    docker(['exec', id, 'rm', '/tmp/bootstrap']);
  } finally { await admin.end(); }
}

async function verify(pool, name, run) {
  const { rows: [row] } = await pool.query(`SELECT current_user AS role,current_database() AS db,
    shobj_description((SELECT oid FROM pg_database WHERE datname=current_database()),'pg_database') AS run,
    has_column_privilege('public."Message"','content','SELECT') AS content,
    has_column_privilege('public."GenerationAttempt"','orchestrationMetadata','SELECT') AS metadata,
    has_column_privilege('public."UsageLedger"','reservationState','UPDATE') AS settlement,
    has_schema_privilege('public','CREATE') AS ddl, has_database_privilege('postgres','CONNECT') AS cross_db,
    (SELECT rolcanlogin FROM pg_roles WHERE rolname='bootstrap') AS bootstrap,
    (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='t02_receipts' AND has_function_privilege(current_user,p.oid,'EXECUTE')) AS functions`);
  assert.deepEqual(row, { role: roles[name], db: database, run: 'isolated M05-E2E run ' + run,
    content: name === 'api', metadata: false, settlement: name === 'worker', ddl: false,
    cross_db: false, bootstrap: false, functions: name === 'worker' ? 2 : name === 'fixture' ? 1 : 0 });
  await assert.rejects(pool.query('SELECT "orchestrationMetadata" FROM "GenerationAttempt" WHERE false'), { code: '42501' });
  if (name !== 'api') await assert.rejects(pool.query('SELECT content FROM "Message" WHERE false'), { code: '42501' });
  if (name !== 'worker') {
    await assert.rejects(pool.query(`UPDATE "UsageLedger" SET "reservationState"='RELEASED' WHERE false`), { code: '42501' });
    await assert.rejects(pool.query('SELECT t02_receipts.record_usage(NULL,1)'), { code: '42501' });
  }
}

async function exercise({ pools, redisUrl, prefix, queue, prisma, run, startServer, startConsumer }) {
  const { fixture } = pools;
  const account = randomUUID(), idea = randomUUID(), first = randomUUID(), second = randomUUID();
  const subject = 'fixture-' + account, instance = 'm05-t02-fixture';
  const digest = createHash('sha256').update(subject).digest('hex');
  await fixture.query('INSERT INTO "UserAccount" (id,"clerkSubject","clerkInstanceId","subjectKey","updatedAt") VALUES ($1,$2,$3,$4,now())',
    [account, subject, instance, digest]);
  await fixture.query('INSERT INTO "Idea" (id,"ownerId",title,"updatedAt") VALUES ($1,$2,\'Synthetic idea\',now())', [idea, account]);
  await fixture.query('INSERT INTO "Conversation" (id,"ideaId","updatedAt") VALUES ($1,$3,now()),($2,$3,now())', [first, second, idea]);
  const principal = { localUserId: account, clerkSubject: subject, clerkInstanceId: instance, accountStatus: 'ACTIVE',
    subjectKeys: [{ version: 1, digest }] };
  const accountScope = JSON.stringify(['ACCOUNT', instance, 1, digest, 'ALL']);
  const ideaScope = JSON.stringify(['IDEA', instance, account, idea]);
  const evidence = (scope, { nonce }) => {
    if (scope !== accountScope && scope !== ideaScope) return null;
    const now = Date.now();
    return { scope, nonce, verdict: 'CLEAR', observedAt: now, validUntil: now + 2000 };
  };
  const apiAuthority = { async lookup(scope, query) {
    const proof = evidence(suppressionScopeKey(scope), query);
    return proof && { ...proof, integrity: 'VERIFIED', coverage: 'COMPLETE', authority: 'INDEPENDENT', epoch: run };
  } };
  const authenticate = async request => request.get('authorization') === 'Bearer test.only.token' ? principal : null;
  const app = express();
  app.use('/api/v1', submissionRoutes(createSubmissionService(createSubmissionRepository(prisma), apiAuthority,
    { clock: () => new Date(), policy, cursorSecret: randomBytes(32) }), authenticate));
  app.use('/api/v1', generationRoutes(createGenerationService(createGenerationRepository(prisma, policy), apiAuthority), authenticate));
  const server = app.listen(0, '127.0.0.1');
  startServer(server);
  await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port + '/api/v1';
  async function request(path, expected, { method = 'GET', key, body } = {}) {
    const response = await fetch(url + path, { method, headers: { Authorization: 'Bearer test.only.token',
      ...(key && { 'Idempotency-Key': key }), ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, expected, result.error?.code);
    return result;
  }
  const convo = id => '/conversations/' + id;
  const submit = (id, expected = 202, key = randomUUID(), body = { clientSubmissionId: randomUUID(), content: 'Synthetic USER' }) =>
    request(convo(id) + '/messages', expected, { method: 'POST', key, body });
  const status = id => request('/generations/' + id, 200);
  const cancel = (id, expected = 202) => request('/generations/' + id + '/cancel', expected, { method: 'POST', key: randomUUID() });
  const history = id => request(convo(id) + '/messages', 200);
  const row = async (table, id) => (await fixture.query('SELECT id,status FROM "' + table + '" WHERE id=$1', [id])).rows[0];
  const ledger = async id => (await fixture.query('SELECT "reservationState","measuredUnits" FROM "UsageLedger" WHERE "reservationId"=$1',
    [id])).rows[0];
  const outbox = async id => {
    const { rows } = await fixture.query('SELECT id,status,"lastErrorCode" FROM "OutboxEvent" WHERE "aggregateId"=$1', [id]);
    assert.equal(rows.length, 1);
    return rows[0];
  };

  let fake = async () => 'Synthetic assistant', expire = false, dispatchDenied = false, executions = 0;
  const allowed = new Set(), work = generationRepository(pools.worker);
  const worker = generationWorker(work, async (scope, query) => {
    const proof = evidence(scope, query);
    return expire && proof ? { ...proof, validUntil: proof.observedAt } : proof;
  }, id => allowed.has(id), async () => { executions++; return fake(); });
  const consumer = generationConsumer(redisUrl, prefix, worker);
  startConsumer(consumer);
  await consumer.waitUntilReady();

  async function poll(id) {
    const { id: eventId } = await outbox(id);
    allowed.add(id);
    const repository = outboxRepository(pools.dispatch, [eventId]);
    const pump = dispatcher(repository, generationQueue(redisUrl, prefix),
      async (scope, query) => dispatchDenied ? null : evidence(scope, query), () => {});
    try { await pump.poll(); } finally { await pump.close(); }
    return eventId;
  }
  async function delivered(id) {
    await poll(id);
    assert.equal((await outbox(id)).status, 'PUBLISHED');
    const job = await queue.getJob(id);
    assert.equal(job.name, 'generation.requested');
    assert.deepEqual(job.data, { generationId: id });
    return job;
  }
  async function terminal(id, state) {
    return until(async () => {
      const value = await status(id);
      return value.status === state && value;
    });
  }

  const key = randomUUID(), body = { clientSubmissionId: randomUUID(), content: 'Synthetic USER' };
  const admitted = await submit(first, 202, key, body);
  const id = admitted.generationId;
  assert.deepEqual(await submit(first, 202, key, body), admitted);
  assert.equal((await status(id)).status, 'PENDING');
  assert.equal((await outbox(id)).status, 'PENDING');
  assert.equal((await ledger(id)).reservationState, 'RESERVED');
  assert.equal((await fixture.query('SELECT id FROM "IdempotencyRecord" WHERE "accountId"=$1', [account])).rowCount, 1);
  assert.equal((await fixture.query('SELECT id FROM "Message" WHERE "conversationId"=$1', [first])).rowCount, 1);
  const job = await delivered(id);
  const completed = await terminal(id, 'COMPLETED');
  assert.equal(completed.selected, true);
  await until(async () => (await job.getState()) === 'completed');
  await poll(id);
  // Re-exercise the worker's duplicate-delivery gate with the real broker
  // envelope. The dispatcher remains the only publisher in this harness.
  await worker.process(job);
  assert.equal(executions, 1);
  assert.equal((await cancel(id, 200)).status, 'COMPLETED');
  assert.deepEqual(await ledger(id), { reservationState: 'SETTLED', measuredUnits: '1.00000' });
  assert.deepEqual((await history(first)).items.map(item => [item.role, item.content]),
    [['USER', 'Synthetic USER'], ['ASSISTANT', 'Synthetic assistant']]);

  fake = async () => 'Regenerated synthetic assistant';
  const regenKey = randomUUID();
  const regenRequest = () => request(convo(first) + '/regenerations', 202, { method: 'POST', key: regenKey,
    body: { triggerMessageId: admitted.messageId } });
  const regenerated = await regenRequest();
  assert.equal((await status(id)).selected, true);
  await delivered(regenerated.id);
  await terminal(regenerated.id, 'COMPLETED');
  assert.deepEqual(await regenRequest(), regenerated);
  assert.equal((await status(id)).selected, false);
  assert.equal((await history(first)).items.at(-1).content, 'Regenerated synthetic assistant');

  const early = (await submit(second)).generationId;
  assert.equal((await cancel(early)).status, 'CANCEL_REQUESTED');
  await poll(early);
  assert.equal(await queue.getJob(early), undefined);
  await worker.recover([early]);
  assert.equal((await status(early)).status, 'CANCELLED');
  assert.equal((await ledger(early)).reservationState, 'RELEASED');

  let entered, resume;
  const started = new Promise(resolve => { entered = resolve; });
  fake = () => new Promise(resolve => { resume = resolve; entered(); });
  const during = (await submit(second)).generationId;
  await delivered(during);
  await Promise.race([started, sleep(4000).then(() => { throw new Error('Fake did not start'); })]);
  assert.equal((await status(during)).status, 'RUNNING');
  try { assert.equal((await cancel(during)).status, 'CANCEL_REQUESTED'); }
  finally { resume('Discarded by cancellation'); }
  await terminal(during, 'CANCELLED');
  assert.equal((await ledger(during)).reservationState, 'SETTLED');
  assert.equal((await fixture.query('SELECT id FROM "Message" WHERE "generationAttemptId"=$1', [during])).rowCount, 0);

  fake = async () => { expire = true; return 'Discarded after clearance expiry'; };
  const known = (await submit(second)).generationId;
  dispatchDenied = true;
  const deniedEvent = await poll(known);
  assert.equal(await queue.getJob(known), undefined);
  assert.equal((await outbox(known)).lastErrorCode, 'SUPPRESSION_UNAVAILABLE');
  await fixture.query('UPDATE "OutboxEvent" SET "nextAttemptAt"=now() WHERE id=$1', [deniedEvent]);
  dispatchDenied = false;
  const knownJob = await delivered(known);
  await until(async () => (await knownJob.getState()) === 'completed');
  expire = false;
  assert.equal((await status(known)).status, 'RUNNING');
  const scope = await work.scope(known);
  const { rows: [attempt] } = await fixture.query('SELECT "leaseEpoch" FROM "GenerationAttempt" WHERE id=$1', [known]);
  assert.equal((await ledger(known)).reservationState, 'RESERVED');
  const expireLease = id => fixture.query('UPDATE "GenerationAttempt" SET "leaseUntil"=now()-interval \'1 second\' WHERE id=$1', [id]);
  await expireLease(known);
  assert.equal(await work.heartbeat(scope, attempt.leaseEpoch), false);
  await worker.recover([known]);
  await worker.recover([known]);
  assert.equal((await status(known)).status, 'FAILED');
  assert.deepEqual(await ledger(known), { reservationState: 'SETTLED', measuredUnits: '1.00000' });
  assert.equal((await fixture.query('SELECT id FROM "Message" WHERE "generationAttemptId"=$1', [known])).rowCount, 0);

  const unknown = (await submit(second)).generationId;
  const event = await outbox(unknown);
  const due = () => fixture.query('UPDATE "OutboxEvent" SET "nextAttemptAt"=now() WHERE id=$1', [event.id]);
  const claims = outboxRepository(pools.dispatch, [event.id]);
  const { events: [stale] } = await claims.claim();
  await fixture.query('UPDATE "OutboxEvent" SET "leaseUntil"=now()-interval \'1 second\' WHERE id=$1', [event.id]);
  const { events: [current] } = await claims.claim();
  assert.equal(current.claimEpoch, stale.claimEpoch + 1);
  assert.equal(await claims.acknowledge(stale), false);
  assert.equal(await claims.fail(current, 'INELIGIBLE', 0), 'PENDING');
  // An otherwise valid intent must fail if the fixture supplies an unused
  // column. Confirm the denial leaves both the deletion and dispatch state intact.
  const deniedOperation = randomUUID();
  const beforeDeniedInsert = await outbox(unknown);
  await assert.rejects(fixture.query(`INSERT INTO "DataOperation"
    (id,"accountId","ideaId",kind,"deadlineAt","clerkInstanceId","ownerSubjectKey","deletionScopeKey","deletionState","policyVersion",status)
    VALUES ($1,$2,$3,'DELETE_IDEA',now()+interval '120 seconds',$4,$5,$6,'DELETION_REQUESTED','synthetic','REQUESTED')`,
  [deniedOperation, account, idea, instance, digest, 'denied:' + run]), { code: '42501' });
  assert.equal((await fixture.query('SELECT id FROM "DataOperation" WHERE id=$1', [deniedOperation])).rowCount, 0);
  assert.deepEqual(await outbox(unknown), beforeDeniedInsert);
  for (const kind of ['DELETE_IDEA', 'DELETE_ACCOUNT']) {
    const operation = randomUUID();
    const inserted = await fixture.query(`INSERT INTO "DataOperation"
      (id,"accountId","ideaId",kind,"deadlineAt","clerkInstanceId","ownerSubjectKey","deletionScopeKey","deletionState","policyVersion")
      VALUES ($1,$2,$3,$4,now()+interval '120 seconds',$5,$6,$7,'DELETION_REQUESTED','synthetic')`,
    [operation, account, kind === 'DELETE_IDEA' ? idea : null, kind, instance, digest, kind + ':' + run]);
    assert.equal(inserted.rowCount, 1);
    try {
      await due();
      await poll(unknown);
      assert.equal(await queue.getJob(unknown), undefined);
      assert.equal((await outbox(unknown)).lastErrorCode, 'INELIGIBLE');
    } finally { await fixture.query('DELETE FROM "DataOperation" WHERE id=$1', [operation]); }
  }
  await due();
  fake = async () => { throw new Error('Synthetic uncertain invocation'); };
  const unknownJob = await delivered(unknown);
  await until(async () => (await unknownJob.getState()) === 'completed');
  await expireLease(unknown);
  await worker.recover([unknown]);
  await worker.recover([unknown]);
  assert.equal((await row('GenerationAttempt', unknown)).status, 'FAILED');
  assert.equal((await ledger(unknown)).reservationState, 'RESERVED');
  assert.equal((await submit(first, 429)).error.code, 'QUOTA_EXCEEDED');
}

test('isolated HTTP submission through outbox, BullMQ and the fake generation worker', {
  skip: !process.argv.includes('--live'), timeout: 120_000
}, async () => {
  const run = randomUUID(), prefix = 'founders-lens-m05-e2e-' + run;
  const network = 'm05-e2e-' + run;
  const credentials = Object.fromEntries([...Object.keys(roles), 'bootstrap', 'redis'].map(name => [name, secret()]));
  const redisUrl = new URL('redis://:' + credentials.redis + '@127.0.0.1:56381/0');
  const pools = {}, containers = [];
  let networkId, redis, queue, consumer, prisma, server;
  function start(resource, image, hostPort, containerPort, tmpfs, options, command) {
    const binding = { [containerPort + '/tcp']: [{ HostIp: '127.0.0.1', HostPort: hostPort }] };
    const id = docker(['run', '-d', '--pull=never', '--network', networkId, '--name', network + '-' + resource,
      '--label', label + '=' + run, '-p', '127.0.0.1:' + hostPort + ':' + containerPort,
      '--tmpfs', tmpfs, ...options, image, ...command]);
    containers.push({ id, resource, image, binding });
    inspect(id, run, resource, binding, image);
    return id;
  }
  try {
    networkId = docker(['network', 'create', '--label', label + '=' + run, network]);
    const pgId = start('pg', pgImage, '55435', '5432', '/var/lib/postgresql/data:rw,nosuid,nodev,mode=0700',
      ['-e', 'POSTGRES_USER=bootstrap', '-e', 'POSTGRES_DB=' + database, '-e', 'POSTGRES_PASSWORD_FILE=/tmp/bootstrap',
        '--entrypoint', 'sh'], ['-ec', 'while [ ! -s /tmp/bootstrap ]; do sleep 1; done; exec docker-entrypoint.sh postgres']);
    docker(['exec', '-i', pgId, 'sh', '-ec', 'umask 077; cat > /tmp/bootstrap-new; mv /tmp/bootstrap-new /tmp/bootstrap'],
      credentials.bootstrap);
    await postgres(pgId, run, credentials);
    const redisId = start('redis', redisImage, '56381', '6379', '/data:rw,noexec,nosuid,nodev,mode=1777',
      ['--entrypoint', 'sh'], ['-ec', 'while [ ! -s /tmp/run-config ]; do sleep 1; done; exec redis-server /tmp/run-config']);
    docker(['exec', '-i', redisId, 'sh', '-ec', 'umask 077; cat > /tmp/run-config-new; mv /tmp/run-config-new /tmp/run-config'],
      'bind 0.0.0.0\nprotected-mode yes\nrequirepass ' + credentials.redis + '\nsave ""\nappendonly no\n');
    for (const [name, role] of Object.entries(roles)) {
      pools[name] = new Pool({ connectionString: 'postgresql://' + role + ':' + credentials[name] +
        '@127.0.0.1:55435/' + database, statement_timeout: 5000 });
      await verify(pools[name], name, run);
    }
    redis = new Redis(redisUrl.href, { maxRetriesPerRequest: 0, connectTimeout: 1000 });
    redis.on('error', () => {});
    await until(() => redis.ping().catch(() => false));
    assert.equal((await redis.info('keyspace')).trim(), '# Keyspace');
    assert.equal((await redis.client('LIST')).trim().split('\n').length, 1);
    const liveBroker = (await redis.info('server')).match(/^run_id:(\w+)/m)?.[1];
    assert.ok(liveBroker);
    queue = new Queue('generation', { prefix, connection: createIORedisClient(redis) });
    const apiUrl = 'postgresql://' + roles.api + ':' + credentials.api + '@127.0.0.1:55435/' + database;
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: apiUrl, statement_timeout: 5000 }) });
    await exercise({ pools, redisUrl, prefix, queue, prisma, run, startServer: value => { server = value; },
      startConsumer: value => { consumer = value; } });
    assert.equal((await redis.info('server')).match(/^run_id:(\w+)/m)?.[1], liveBroker);
  } finally {
    try {
      if (server) await new Promise(resolve => server.close(resolve));
      await consumer?.close();
      await queue?.close();
      redis?.disconnect();
      await prisma?.$disconnect();
      await Promise.all(Object.values(pools).map(pool => pool.end()));
    } finally {
      // The entire disposable cluster is the fixture. Reverify every ID
      // before removal, and never delete a volume or an existing service.
      for (const { id, resource, binding, image } of containers.reverse()) {
        inspect(id, run, resource, binding, image);
        docker(['rm', '-f', id]);
      }
      if (networkId) {
        assert.equal(docker(['network', 'inspect', '--format', '{{index .Labels "' + label + '"}}', networkId]), run);
        docker(['network', 'rm', networkId]);
      }
    }
  }
});
