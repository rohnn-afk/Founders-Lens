// Opt-in real PostgreSQL and Redis tests. The harness verifies the dedicated
// Docker run before writes and cleans up only fixture UUIDs created here.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import test from 'node:test';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { Queue, createIORedisClient } from 'bullmq';
import { testTargets, policy } from '../apps/dispatcher/dist/config.js';
import { dispatcher } from '../apps/dispatcher/dist/dispatch.js';
import { generationQueue } from '../apps/dispatcher/dist/generation-queue.js';
import { outboxRepository } from '../apps/dispatcher/dist/outbox-repository.js';

const sha = '19fcf7f5f144d1ff39a00a489193392e9deaa60617ebe2f42a8ee576e203032b';
const fresh = async (scope, query) => ({
  scope, nonce: query.nonce, verdict: 'CLEAR', observedAt: Date.now(), validUntil: Date.now() + 3000
});

test('isolated M05 PostgreSQL and Redis crash, fencing and reconciliation', {
  skip: !process.argv.includes('--live'), timeout: 80_000
}, async t => {
  const env = parseEnv(await readFile('.env.m05.test', 'utf8'));
  const targets = testTargets(env);
  const run = env.M05_RUN_ID;
  const docker = path.join(process.env.LOCALAPPDATA, 'Programs/DockerDesktop/resources/bin/docker.exe');
  function command(...args) {
    try { return execFileSync(docker, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
    catch { throw new Error('Could not verify or control the isolated Docker fixture'); }
  }
  const inspect = id => JSON.parse(command('inspect', id))[0];
  const network = inspect(env.M05_NETWORK_ID);
  assert.equal(network.Name, 'founders-lens-m05-net-' + run);
  assert.equal(network.Labels['founders-lens.m05-run'], run);
  assert.deepEqual(Object.keys(network.Containers).sort(), [env.M05_POSTGRES_CONTAINER_ID, env.M05_REDIS_CONTAINER_ID].sort());
  for (const [id, name, port, binding] of [
    [env.M05_POSTGRES_CONTAINER_ID, 'pg', '5432/tcp', '55433'],
    [env.M05_REDIS_CONTAINER_ID, 'redis', '6379/tcp', '56380']
  ]) {
    const resource = inspect(id);
    assert.equal(resource.Id, id);
    assert.equal(resource.Name, '/founders-lens-m05-' + name + '-' + run);
    assert.equal(resource.Config.Labels['founders-lens.m05-run'], run);
    assert.equal(resource.State.Status, 'running');
    assert.deepEqual(Object.keys(resource.NetworkSettings.Networks), [network.Name]);
    assert.deepEqual(resource.HostConfig.PortBindings[port], [{ HostIp: '127.0.0.1', HostPort: binding }]);
  }

  const connect = url => new Pool({ connectionString: url.toString(), max: 4, connectionTimeoutMillis: 1500, statement_timeout: 5000 });
  const pool = connect(targets.dispatcher), fixtures = connect(targets.fixture);
  const redis = new Redis(targets.redis.toString(), { lazyConnect: true, retryStrategy: () => null,
    maxRetriesPerRequest: 0, connectTimeout: 1000 });
  redis.on('error', () => {});
  const broker = new Queue('generation', { prefix: targets.prefix, connection: createIORedisClient(redis) });
  broker.on('error', () => {});
  const queue = generationQueue(targets.redis, targets.prefix, undefined, Number(targets.redis.port));
  const rows = [];
  let writesAllowed = false;
  t.after(async () => {
    queue.close();
    try {
      if (writesAllowed) for (const ids of rows) {
        await broker.remove(ids.generation);
        assert.equal(await broker.getJob(ids.generation), undefined);
        const client = await fixtures.connect();
        try {
          await client.query('BEGIN');
          for (const [table, id] of [['OutboxEvent', ids.event], ['GenerationAttempt', ids.generation],
            ['Message', ids.message], ['Conversation', ids.conversation], ['Idea', ids.idea], ['UserAccount', ids.account]]) {
            await client.query('DELETE FROM "' + table + '" WHERE id=$1', [id]);
            assert.equal((await client.query('SELECT id FROM "' + table + '" WHERE id=$1', [id])).rowCount, 0);
          }
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally { client.release(); }
      }
    } finally {
      await broker.close();
      redis.disconnect();
      await Promise.all([pool.end(), fixtures.end()]);
    }
  });

  for (const [db, role] of [[pool, 'fl_m05_dispatcher'], [fixtures, 'fl_m05_fixture']]) {
    const { rows: [identity] } = await db.query(`SELECT current_user AS role, current_database() AS database,
      shobj_description((SELECT oid FROM pg_database WHERE datname=current_database()),'pg_database') AS run,
      has_column_privilege(current_user,'public."Message"','content','SELECT') AS private,
      has_column_privilege(current_user,'public."OutboxEvent"','status','UPDATE') AS update_outbox,
      has_table_privilege(current_user,'public."OutboxEvent"','DELETE') AS delete_outbox,
      has_column_privilege(current_user,'public."GenerationAttempt"','status','UPDATE') AS update_generation`);
    assert.deepEqual(identity, { role, database: 'founders_lens_m05_test', run: 'isolated M05 run ' + run,
      private: false, update_outbox: db === pool, delete_outbox: db === fixtures, update_generation: false });
  }
  // These restricted roles have no migration-history grant. Verify the
  // recorded baseline against the schema visible in PostgreSQL catalogs.
  const migration = await readFile('apps/api/prisma/migrations/0001_approved_baseline/migration.sql');
  const { createHash } = await import('node:crypto');
  assert.equal(createHash('sha256').update(migration).digest('hex'), sha);
  const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  assert.deepEqual(tables.map(row => row.tablename), [
    ...[...migration.toString().matchAll(/^CREATE TABLE "([^"]+)"/gm)].map(match => match[1]), '_prisma_migrations'
  ].sort());
  const manifest = (await pool.query(`SELECT pg_get_constraintdef(oid) AS rule FROM pg_constraint
    WHERE conrelid='public."Message"'::regclass`)).rows;
  assert.ok(manifest.some(row => row.rule.includes('FOREIGN KEY ("conversationId", "ideaId")')));
  assert.equal((await redis.info('server')).match(/run_id:([a-f0-9]+)/)?.[1], env.M05_REDIS_SERVER_ID);
  assert.equal(await redis.ping(), 'PONG');
  const expectedFixtureTables = ['UserAccount', 'Idea', 'Conversation', 'Message', 'GenerationAttempt', 'OutboxEvent'];
  const grants = await fixtures.query(`SELECT bool_and(has_table_privilege(current_user, format('public.%I', table_name),'INSERT')
    AND has_table_privilege(current_user,format('public.%I', table_name),'DELETE')
    AND has_column_privilege(current_user,format('public.%I', table_name),'id','SELECT')) AS permitted FROM unnest($1::text[]) table_name`,
  [expectedFixtureTables]);
  assert.equal(grants.rows[0].permitted, true);
  writesAllowed = true;

  async function seed({ status = 'PENDING', attempts = 0, deadline = 100_000, created = 0, invalid = false } = {}) {
    const [account, idea, conversation, message, generation, event] = Array.from({ length: 6 }, randomUUID);
    const ids = { account, idea, conversation, message, generation, event };
    const c = await fixtures.connect();
    try {
      await c.query('BEGIN');
      await c.query(`INSERT INTO "UserAccount" (id,"clerkSubject","clerkInstanceId","subjectKey","updatedAt")
        VALUES ($1,$2,$3,$4,now())`, [account, 'm05_' + account, 'm05_' + run, randomBytes(32).toString('hex')]);
      await c.query('INSERT INTO "Idea" (id,"ownerId",title,"updatedAt") VALUES ($1,$2,$3,now())', [idea, account, 'Synthetic']);
      await c.query('INSERT INTO "Conversation" (id,"ideaId","updatedAt") VALUES ($1,$2,now())', [conversation, idea]);
      await c.query(`INSERT INTO "Message" (id,"ideaId","conversationId",sequence,role,content,"clientSubmissionKey","submissionSha256")
        VALUES ($1,$2,$3,1,'USER','{"text":"synthetic"}',$4,$5)`, [message, idea, conversation, randomUUID(), '0'.repeat(64)]);
      await c.query(`INSERT INTO "GenerationAttempt" (id,"conversationId","triggerMessageId","attemptNumber","deadlineAt")
        VALUES ($1,$2,$3,1,now()+$4::int*interval '1 millisecond')`, [generation, conversation, message, deadline]);
      await c.query(`INSERT INTO "OutboxEvent" (id,kind,"aggregateType","aggregateId",payload,status,"dispatchAttempts",
        "claimEpoch","leaseUntil","createdAt","publishedAt")
        VALUES ($1,'generation.requested','GenerationAttempt',$2,$3,$4::"OutboxStatus",$5,$5,
          CASE WHEN $4::"OutboxStatus"='CLAIMED' THEN now()-interval '1 second' END,now()-$6::int*interval '1 millisecond',
          CASE WHEN $4::"OutboxStatus"='PUBLISHED' THEN now() END)`,
      [event, generation, { generationId: invalid ? randomUUID() : generation }, status, attempts, created]);
      await c.query('COMMIT');
      rows.push(ids);
      return ids;
    } catch (error) { await c.query('ROLLBACK'); throw error; }
    finally { c.release(); }
  }

  const repo = (...items) => outboxRepository(pool, items.map(item => item.event));
  const state = async item => (await fixtures.query('SELECT status,"dispatchAttempts","claimEpoch","lastErrorCode" FROM "OutboxEvent" WHERE id=$1', [item.event])).rows[0];
  const runner = (repository, publisher = queue, authority = fresh) => dispatcher(repository, publisher, authority, () => {}, { random: () => 0 });
  const byId = item => broker.getJob(item.generation);

  await t.test('two dispatchers take disjoint bounded batches and expiry fences abandoned claims', async () => {
    const batch = await Promise.all(Array.from({ length: 8 }, () => seed()));
    const repository = repo(...batch);
    const [first, second] = await Promise.all([repository.claim(), repository.claim()]);
    assert.equal(first.events.length, 4);
    assert.equal(second.events.length, 4);
    assert.equal(new Set([...first.events, ...second.events].map(event => event.id)).size, 8);
    const fixture = await seed({ status: 'CLAIMED', attempts: 1 });
    const lease = repo(fixture);
    const { events: [current] } = await lease.claim();
    assert.equal(current.claimEpoch, 2);
    assert.equal(await lease.acknowledge({ ...current, claimEpoch: 1 }), false);
    assert.equal(await lease.fail({ ...current, claimEpoch: 1 }, 'BROKER_UNCERTAIN', 0), undefined);
    assert.equal(await byId(fixture), undefined);
  });

  await t.test('lost acknowledgement and abandoned publication reuse the retained job ID', async () => {
    const lost = await seed();
    const repository = repo(lost);
    const failedAck = runner(repository, { ...queue, async publish(id, window) {
      assert.equal(await queue.publish(id, window), 'retained');
      throw new Error('Simulated lost broker acknowledgement');
    } });
    await failedAck.poll();
    assert.equal((await state(lost)).status, 'PENDING');
    await sleep(160);
    await runner(repository).poll();
    assert.equal((await state(lost)).status, 'PUBLISHED');
    assert.equal((await state(lost)).dispatchAttempts, 2);
    const before = await seed();
    const abandoned = await seed();
    const unrelated = await seed();
    const unrelatedBefore = await state(unrelated);
    const abandonedRepo = repo(before, abandoned);
    const abandonedClaims = (await abandonedRepo.claim()).events;
    assert.equal(abandonedClaims.length, 2);
    await broker.add('generation.requested', { generationId: abandoned.generation }, {
      jobId: abandoned.generation, removeOnComplete: policy.retention, removeOnFail: policy.retention
    });
    assert.equal(await byId(before), undefined);
    // Leave both committed claims unacknowledged across the real DB lease.
    // One represents process death before enqueue and one after broker add.
    await sleep(policy.leaseMs + 100);
    await runner(abandonedRepo).poll();
    assert.equal((await state(before)).status, 'PUBLISHED');
    assert.equal((await state(before)).dispatchAttempts, 2);
    assert.equal((await state(abandoned)).dispatchAttempts, 2);
    for (const old of abandonedClaims) assert.equal(await abandonedRepo.acknowledge(old), false);
    assert.deepEqual(await state(unrelated), unrelatedBefore);
    assert.equal(await byId(unrelated), undefined);
    const job = await byId(abandoned);
    assert.equal(job.id, abandoned.generation);
    assert.deepEqual(job.data, { generationId: abandoned.generation });
    assert.deepEqual(job.opts.removeOnComplete, policy.retention);
  });

  await t.test('an actual isolated Redis interruption defers PostgreSQL work', async () => {
    const item = await seed();
    const isolated = inspect(env.M05_REDIS_CONTAINER_ID);
    assert.equal(isolated.Id, env.M05_REDIS_CONTAINER_ID);
    assert.equal(isolated.Config.Labels['founders-lens.m05-run'], run);
    command('pause', isolated.Id);
    try {
      await runner(repo(item)).poll();
      assert.equal((await state(item)).status, 'PENDING');
      assert.equal((await state(item)).lastErrorCode, 'BROKER_UNCERTAIN');
    } finally { command('unpause', isolated.Id); }
    await sleep(175);
    await runner(repo(item)).poll();
    assert.equal((await state(item)).status, 'PUBLISHED');
  });

  await t.test('reconciliation is explicit, budgeted and fixture-scoped', async () => {
    const item = await seed({ status: 'PUBLISHED', attempts: 1 });
    const out = runner(repo(item));
    await out.poll();
    assert.equal(await byId(item), undefined);
    await out.reconcile([item.event]);
    assert.equal((await state(item)).dispatchAttempts, 2);
    assert.equal((await state(item)).status, 'PUBLISHED');
    await out.reconcile([item.event]);
    assert.equal((await state(item)).dispatchAttempts, 2);
    assert.throws(() => out.reconcile([item.event, randomUUID()]), /Unknown M05 fixture/);
  });

  await t.test('suppression, invalid events, deadlines and exhaustion grant no broker authority', async () => {
    const denied = await seed({ attempts: 4 });
    await runner(repo(denied), queue, async () => null).poll();
    assert.equal((await state(denied)).status, 'FAILED');
    assert.equal((await state(denied)).lastErrorCode, 'SUPPRESSION_UNAVAILABLE');
    assert.equal(await byId(denied), undefined);
    for (const options of [{ deadline: -1 }, { created: 121_000 }, { status: 'CLAIMED', attempts: 5 }, { invalid: true }]) {
      const item = await seed(options);
      await runner(repo(item)).poll();
      assert.equal((await state(item)).status, 'FAILED');
      assert.equal(await byId(item), undefined);
    }
  });

  for (const item of rows) {
    const attempt = (await fixtures.query('SELECT status,"leaseEpoch" FROM "GenerationAttempt" WHERE id=$1', [item.generation])).rows[0];
    assert.deepEqual(attempt, { status: 'PENDING', leaseEpoch: 0 });
    assert.equal((await fixtures.query('SELECT id FROM "Message" WHERE "conversationId"=$1', [item.conversation])).rowCount, 1);
    assert.equal((await fixtures.query('SELECT id FROM "UsageLedger" WHERE "accountId"=$1', [item.account])).rowCount, 0);
    assert.equal((await fixtures.query('SELECT id FROM "IdempotencyRecord" WHERE "accountId"=$1', [item.account])).rowCount, 0);
  }
});
