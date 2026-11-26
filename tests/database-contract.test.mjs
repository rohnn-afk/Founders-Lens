// Covers local CLI safety with synthetic dependencies and verifies the
// approved schema and runtime restrictions with opt-in PostgreSQL fixtures.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { connection, databases, localMigrationChecksumMatches, main, migrationPath, reviewedMigration, root, settings, sha256 } from '../apps/api/scripts/database.mjs';
import { databaseConfig } from '../apps/api/dist/persistence/config.js';
import { createDatabaseClient } from '../apps/api/dist/persistence/client.js';

const live = process.argv.includes('--live');
const hash = 'a'.repeat(64); // Synthetic content fingerprint, never a credential.
const quote = value => {
  assert.match(value, /^[A-Za-z][A-Za-z0-9_]*$/);
  return `"${value}"`;
};
async function insert(client, table, data) {
  const entries = Object.entries(data);
  return client.query(`INSERT INTO ${quote(table)} (${entries.map(([key]) => quote(key)).join(',')}) VALUES (${entries.map((_, index) => '$' + (index + 1)).join(',')})`, entries.map(([, value]) => value));
}
async function rejected(client, action, code, constraint) {
  await client.query('SAVEPOINT expected_rejection');
  let failure;
  try { await action(); } catch (error) { failure = error; }
  await client.query('ROLLBACK TO SAVEPOINT expected_rejection');
  await client.query('RELEASE SAVEPOINT expected_rejection');
  assert.ok(failure, 'Prohibited database effect unexpectedly succeeded');
  assert.equal(failure.code, code);
  if (constraint) assert.equal(failure.constraint, constraint);
}
async function transaction(url, action) {
  const client = connection(url);
  await client.connect();
  try {
    await client.query('BEGIN');
    await action(client);
  } finally { await client.query('ROLLBACK'); await client.end(); }
}
async function fixture(client) {
  const owner = randomUUID(), otherOwner = randomUUID(), idea = randomUUID(), otherIdea = randomUUID();
  for (const id of [owner, otherOwner]) await insert(client, 'UserAccount', {
    id, clerkSubject: 'm02-synthetic-' + id, clerkInstanceId: 'm02-synthetic',
    subjectKey: id.replaceAll('-', '') + id.replaceAll('-', ''), updatedAt: new Date()
  });
  for (const [id, ownerId] of [[idea, owner], [otherIdea, otherOwner]]) {
    await insert(client, 'Idea', { id, ownerId, title: 'M02 synthetic fixture', updatedAt: new Date() });
  }
  const conversation = randomUUID(), otherConversation = randomUUID(), message = randomUUID();
  for (const [id, ideaId] of [[conversation, idea], [otherConversation, otherIdea]]) {
    await insert(client, 'Conversation', { id, ideaId, updatedAt: new Date() });
  }
  await insert(client, 'Message', { id: message, ideaId: idea, conversationId: conversation,
    sequence: 1, role: 'USER', content: '{}', clientSubmissionKey: randomUUID(), submissionSha256: hash });
  return { owner, otherOwner, idea, otherIdea, conversation, otherConversation, message };
}
const attempt = (f, number, extra = {}) => ({ id: randomUUID(), conversationId: f.conversation,
  triggerMessageId: f.message, attemptNumber: number, deadlineAt: new Date(Date.now() + 60_000), ...extra });

test('Prisma 7 translation preserves the entire approved domain and additive guard order', async () => {
  const { sql } = await reviewedMigration();
  const schema = await readFile(path.join(root, 'apps/api/prisma/schema.prisma'), 'utf8');
  assert.equal((schema.match(/^model /gm) ?? []).length, 25);
  assert.match(schema, /^model GenerationProviderReceipt \{/m);
  assert.equal((schema.match(/^enum /gm) ?? []).length, 24);
  assert.ok(sql.indexOf('CREATE TRIGGER') > sql.lastIndexOf('ADD CONSTRAINT', sql.indexOf('-- Approved SQL guards')));
  assert.match(sql, /experiment_plan_title_shape[\s\S]*?NOT VALID/);
  assert.match(schema, /provider\s*=\s*"prisma-client"/);
});

test('canonical migration bytes and historical local checksums have separate contracts', async () => {
  const { steps } = await reviewedMigration();
  const historical = [
    ['0002_p9_context', 'e30c7f7003eb74fa715e3457d4ec220f08bc33f9b66287dab2d3979a1c212fff'],
    ['0003_p9_provider_receipt', 'a0a3a093f734c1f55440cd5b5a74f386191bb1a6e5403a78d7248511ecf03058'],
    ['0004_m06_selected_context', '7533b2e2afdabf85653f100fce9abb7cf24d9a81f885dc740cd51fc975770194']
  ];
  for (const [name, checksum] of historical) {
    const step = steps.find(candidate => candidate.name === name);
    assert.ok(step);
    assert.notEqual(step.checksum, checksum);
    assert.ok(localMigrationChecksumMatches(step, checksum));
    assert.equal(localMigrationChecksumMatches(steps[0], checksum), false);
  }
});

test('runtime configuration rejects missing, owner, remote and malformed connection settings', () => {
  assert.throws(() => databaseConfig({}));
  const valid = `postgresql://fl_m02_runtime:${'1'.repeat(64)}@127.0.0.1:55432/founders_lens_m02_test?schema=public`;
  assert.equal(databaseConfig({ DATABASE_URL: valid }).connectionString, valid);
  for (const url of [valid.replace('fl_m02_runtime', 'fl_m02_migrator'), valid.replace('127.0.0.1', 'example.com'),
    valid.replace('55432', '5432'), valid.replace('_test', '_production'), valid + '&sslmode=disable', 'not-a-url']) {
    assert.throws(() => databaseConfig({ DATABASE_URL: url }), /Invalid restricted database configuration/);
  }
});

function syntheticCli({ host = '127.0.0.1', existingRoles = [], existingDatabases = [], failAt } = {}) {
  const migratorPassword = 'a'.repeat(64);
  const runtimePassword = 'b'.repeat(64);
  const url = (role, password, database) => `postgresql://${role}:${password}@${host}:55432/${database}?schema=public`;
  const migratorUrl = database => url('fl_m02_migrator', migratorPassword, database);
  const runtimeUrl = database => url('fl_m02_runtime', runtimePassword, database);
  const settingsText = [
    `MIGRATION_DATABASE_URL=${migratorUrl(databases[0])}`,
    `TEST_MIGRATION_DATABASE_URL=${migratorUrl(databases[1])}`,
    `SHADOW_DATABASE_URL=${migratorUrl(databases[2])}`,
    `DATABASE_URL=${runtimeUrl(databases[0])}`,
    `TEST_DATABASE_URL=${runtimeUrl(databases[1])}`
  ].join('\n');
  const calls = [];
  const reports = [];
  const dependencies = {
    readSettingsFile: async () => settingsText,
    report: message => reports.push(message),
    openAdmin: async () => {
      calls.push('open');
      return {
        async connect() { calls.push('connect'); },
        async end() { calls.push('end'); },
        async query(sql) {
          calls.push(sql.startsWith('CREATE ROLE ') ? sql.split(' ').slice(0, 3).join(' ') : sql);
          if (sql.startsWith('SELECT rolname')) return { rows: existingRoles };
          if (sql.startsWith('SELECT datname')) return { rows: existingDatabases };
          if (sql.startsWith(failAt ?? '\0')) {
            throw Object.assign(new Error(`Synthetic driver failure at ${migratorUrl(databases[0])}`),
              { code: runtimePassword });
          }
          return { rows: [] };
        }
      };
    }
  };
  return { calls, reports, dependencies, secrets: [migratorPassword, runtimePassword] };
}

test('database CLI rejects a remote target before opening an admin connection', async () => {
  const fixture = syntheticCli({ host: 'example.invalid' });
  await assert.rejects(main('provision', fixture.dependencies), /failed during local database target validation/);
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(fixture.reports, []);
});

test('database CLI plan and collision refusal issue inventory reads only', async () => {
  for (const inventory of [
    { existingRoles: [{ rolname: 'fl_m02_runtime' }] },
    { existingDatabases: [{ datname: databases[0] }] }
  ]) {
    const plan = syntheticCli(inventory);
    await main('plan', plan.dependencies);
    const provision = syntheticCli(inventory);
    await assert.rejects(main('provision', provision.dependencies), /already exists\. No setup writes were attempted/);
    assert.deepEqual(provision.calls, plan.calls);
    assert.deepEqual(plan.calls.map(call => call.split(' ')[0]), ['open', 'connect', 'SELECT', 'SELECT', 'end']);
  }
});

test('database CLI reports only confirmed setup progress and never retries', async t => {
  for (const [failAt, stoppedAt, confirmed, writes] of [
    ['CREATE ROLE fl_m02_runtime', 'role creation or commit', 'inventory check',
      ['BEGIN', "SET LOCAL password_encryption = 'scram-sha-256'", 'CREATE ROLE fl_m02_migrator', 'CREATE ROLE fl_m02_runtime', 'ROLLBACK']],
    ['COMMIT', 'role creation or commit', 'inventory check', ['COMMIT', 'ROLLBACK']],
    [`CREATE DATABASE ${databases[0]}`, `create database ${databases[0]}`, 'role commit',
      ['COMMIT', `CREATE DATABASE ${databases[0]} OWNER fl_m02_migrator`]],
    [`REVOKE ALL ON DATABASE ${databases[0]}`, `revoke public access to ${databases[0]}`, `create database ${databases[0]}`,
      [`CREATE DATABASE ${databases[0]} OWNER fl_m02_migrator`, `REVOKE ALL ON DATABASE ${databases[0]} FROM PUBLIC`]]
  ]) {
    await t.test(stoppedAt, async () => {
      const fixture = syntheticCli({ failAt });
      await assert.rejects(main('provision', fixture.dependencies), error => {
        assert.equal(error.message, `Provisioning stopped at: ${stoppedAt}. Last confirmed step: ${confirmed}. Run the read-only plan and review the inventory before manual recovery.`);
        for (const secret of fixture.secrets) assert.ok(![error.message, ...fixture.reports].join(' ').includes(secret));
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(fixture.reports.length, 1, 'Only the plan inventory was reported');
      assert.equal(fixture.calls.filter(call => call.startsWith(failAt)).length, 1);
      assert.deepEqual(fixture.calls.slice(-writes.length - 1), [...writes, 'end']);
    });
  }
});

test('real PostgreSQL database foundation', { skip: !live, timeout: 90_000 }, async t => {
  const values = await settings();
  const { sql, checksum } = await reviewedMigration();

  await t.test('both databases have the reviewed migrations, constraints, indexes, enums and triggers', async () => {
    const expectedMigrations = [
      ['0001_approved_baseline', checksum],
      ...await Promise.all(['0002_p9_context', '0003_p9_provider_receipt', '0004_m06_selected_context',
        '0005_m06_approved_memory'].map(async name => [
        name, sha256(await readFile(path.join(root, 'apps/api/prisma/migrations', name, 'migration.sql')))
      ]))
    ];
    for (const key of ['MIGRATION_DATABASE_URL', 'TEST_MIGRATION_DATABASE_URL']) {
      await transaction(values[key], async client => {
        const migrations = (await client.query('SELECT migration_name,checksum,finished_at,rolled_back_at FROM "_prisma_migrations" ORDER BY started_at')).rows;
        assert.deepEqual(migrations.map(row => row.migration_name), expectedMigrations.map(([name]) => name));
        for (const [index, [name, checksum]] of expectedMigrations.entries()) {
          assert.ok(localMigrationChecksumMatches({ name, checksum }, migrations[index].checksum));
        }
        assert.ok(migrations.every(row => row.finished_at && row.rolled_back_at === null));
        const tables = (await client.query("SELECT tablename,tableowner FROM pg_tables WHERE schemaname='public'")).rows;
        assert.equal(tables.length, 26);
        assert.ok(tables.some(row => row.tablename === 'GenerationProviderReceipt'));
        assert.ok(tables.every(row => row.tableowner === 'fl_m02_migrator'));
        const enums = (await client.query("SELECT t.typname, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' GROUP BY t.typname")).rows;
        assert.equal(enums.length, 24);
        for (const match of sql.matchAll(/^CREATE TYPE "([^"]+)" AS ENUM \(([^;]+)\);/gm)) {
          assert.deepEqual(enums.find(row => row.typname === match[1])?.labels, [...match[2].matchAll(/'([^']+)'/g)].map(item => item[1]));
        }
        const indexes = new Set((await client.query("SELECT indexname FROM pg_indexes WHERE schemaname='public'")).rows.map(row => row.indexname));
        for (const match of sql.matchAll(/^CREATE (?:UNIQUE )?INDEX "([^"]+)"/gm)) assert.ok(indexes.has(match[1]), match[1]);
        const constraints = (await client.query("SELECT conname, convalidated FROM pg_constraint WHERE connamespace='public'::regnamespace")).rows;
        for (const match of sql.matchAll(/(?:ADD CONSTRAINT|CONSTRAINT) "([^"]+)"/g)) {
          assert.ok(constraints.some(row => row.conname === match[1]), match[1]);
        }
        assert.equal(constraints.find(row => row.conname === 'experiment_plan_title_shape').convalidated, false);
        const triggers = (await client.query("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)")).rows;
        assert.equal(triggers.length, 4);
        for (const match of sql.matchAll(/^CREATE TRIGGER (\w+)/gm)) assert.ok(triggers.some(row => row.tgname === match[1]));
        const helper = (await client.query("SELECT prosecdef, proconfig FROM pg_proc WHERE proname='fl_privacy_delete_authorized' AND pronamespace='public'::regnamespace")).rows[0];
        assert.equal(helper.prosecdef, false);
        assert.deepEqual(helper.proconfig, ['search_path=pg_catalog, public']);
      });
    }
  });

  await t.test('runtime cannot perform DDL, DELETE, role escalation, shadow access or migration access', async () => {
    await transaction(values.TEST_DATABASE_URL, async client => {
      const role = (await client.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
      assert.ok(Object.values(role).every(value => value === false));
      assert.equal((await client.query('SELECT count(*)::int AS count FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)')).rows[0].count, 0);
      assert.equal((await client.query('SELECT has_database_privilege(current_user,$1,\'CONNECT\') AS allowed', [databases[2]])).rows[0].allowed, false);
      assert.equal((await client.query("SELECT has_database_privilege(current_user,current_database(),'TEMP') AS allowed")).rows[0].allowed, false);
      for (const match of sql.matchAll(/^CREATE TABLE "([^"]+)"/gm)) {
        assert.equal((await client.query('SELECT has_table_privilege(current_user,$1,\'DELETE\') AS allowed', ['public."' + match[1] + '"'])).rows[0].allowed, false);
      }
      for (const query of ['CREATE TABLE public.m02_forbidden(id integer)', 'SELECT * FROM "_prisma_migrations"',
        'ALTER TABLE "Idea" DISABLE TRIGGER ALL', 'DELETE FROM "Idea"', 'SET ROLE fl_m02_migrator']) {
        await rejected(client, () => client.query(query), '42501');
      }
      assert.equal((await client.query("SELECT count(*)::int AS count FROM pg_roles WHERE rolname='fl_purge_owner'")).rows[0].count, 0);
      await client.query("SELECT set_config('fl.purge_operation',$1,true),set_config('fl.purge_epoch','1',true)", [randomUUID()]);
      assert.equal((await client.query('SELECT public.fl_privacy_delete_authorized($1) AS allowed', [randomUUID()])).rows[0].allowed, false);
      await rejected(client, () => client.query('SET ROLE fl_purge_owner'), '22023');
    });
  });

  await t.test('same-idea foreign keys and ownership-scoped reads reject foreign fixture identifiers', async () => {
    await transaction(values.TEST_DATABASE_URL, async client => {
      const f = await fixture(client);
      assert.equal((await client.query('SELECT id FROM "Idea" WHERE id=$1 AND "ownerId"=$2', [f.otherIdea, f.owner])).rowCount, 0);
      const assumption = randomUUID(), experiment = randomUUID(), evidence = randomUUID();
      await insert(client, 'Assumption', { id: assumption, ideaId: f.idea, statement: 'synthetic', updatedAt: new Date() });
      await insert(client, 'Experiment', { id: experiment, ideaId: f.idea, hypothesis: 'synthetic', plan: '{}', successCriteria: '{}', updatedAt: new Date() });
      await insert(client, 'EvidenceRecord', { id: evidence, ideaId: f.otherIdea, origin: 'USER_REPORT', finding: 'synthetic' });
      await rejected(client, () => insert(client, 'AssumptionEvidence', { assumptionId: assumption, evidenceId: evidence, ideaId: f.idea, relationship: 'SUPPORTS' }), '23503');
      await rejected(client, () => insert(client, 'Experiment', { id: randomUUID(), ideaId: f.otherIdea, assumptionId: assumption, hypothesis: 'synthetic', plan: '{}', successCriteria: '{}', updatedAt: new Date() }), '23503');
      await rejected(client, () => insert(client, 'Learning', { id: randomUUID(), ideaId: f.otherIdea, experimentId: experiment, interpretation: 'synthetic', approvedById: f.owner }), '23503');
      await rejected(client, () => insert(client, 'ResearchJob', { id: randomUUID(), ideaId: f.otherIdea, triggerMessageId: f.message, query: 'synthetic', dedupeKey: randomUUID(), budget: '{}', deadlineAt: new Date() }), '23503');
      const generation = attempt(f, 1);
      await insert(client, 'GenerationAttempt', generation);
      await rejected(client, () => insert(client, 'Message', { id: randomUUID(), ideaId: f.otherIdea, conversationId: f.otherConversation, sequence: 1, role: 'ASSISTANT', content: '{}', generationAttemptId: generation.id }), '23503');
    });
  });

  await t.test('active/selected uniqueness, CANCEL_REQUESTED retention and atomic selection rollback', async () => {
    await transaction(values.TEST_DATABASE_URL, async client => {
      const f = await fixture(client), first = attempt(f, 1), second = attempt(f, 2, { status: 'COMPLETED' });
      await insert(client, 'GenerationAttempt', first);
      await rejected(client, () => insert(client, 'GenerationAttempt', attempt(f, 3)), '23505', 'GenerationAttempt_one_active_per_conversation');
      await client.query('UPDATE "GenerationAttempt" SET status=\'CANCEL_REQUESTED\' WHERE id=$1', [first.id]);
      await rejected(client, () => insert(client, 'GenerationAttempt', attempt(f, 3)), '23505', 'GenerationAttempt_one_active_per_conversation');
      await rejected(client, () => client.query('UPDATE "GenerationAttempt" SET "selectedAt"=now() WHERE id=$1', [first.id]), '23514', 'generation_selected_only_if_complete');
      await client.query('UPDATE "GenerationAttempt" SET status=\'COMPLETED\', "selectedAt"=now() WHERE id=$1', [first.id]);
      await insert(client, 'GenerationAttempt', second);
      await rejected(client, () => client.query('UPDATE "GenerationAttempt" SET "selectedAt"=now() WHERE id=$1', [second.id]), '23505', 'GenerationAttempt_one_selected_per_user_turn');
      await client.query('SAVEPOINT selection_swap');
      await client.query('UPDATE "GenerationAttempt" SET "selectedAt"=NULL WHERE id=$1', [first.id]);
      await client.query('UPDATE "GenerationAttempt" SET "selectedAt"=now() WHERE id=$1', [second.id]);
      await client.query('ROLLBACK TO SAVEPOINT selection_swap');
      assert.equal((await client.query('SELECT id FROM "GenerationAttempt" WHERE "selectedAt" IS NOT NULL AND "conversationId"=$1', [f.conversation])).rows[0].id, first.id);
    });
  });

  await t.test('CHECK constraints enforce versions, message provenance, proposal NULL handling and experiment shape', async () => {
    await transaction(values.TEST_DATABASE_URL, async client => {
      const f = await fixture(client), memory = randomUUID();
      await insert(client, 'ConfirmedMemory', { id: memory, ideaId: f.idea, kind: 'FACT', currentContent: '{}', updatedAt: new Date() });
      await rejected(client, () => client.query('UPDATE "Idea" SET version=0 WHERE id=$1', [f.idea]), '23514', 'idea_version_positive');
      await rejected(client, () => insert(client, 'GenerationAttempt', attempt(f, 0)), '23514', 'generation_attempt_number_positive');
      await rejected(client, () => insert(client, 'Message', { id: randomUUID(), ideaId: f.idea, conversationId: f.conversation, sequence: 2, role: 'USER', content: '{}' }), '23514', 'user_message_requires_submission_key');
      await rejected(client, () => insert(client, 'MemoryProposal', { id: randomUUID(), ideaId: f.idea, targetMemoryId: memory, expectedMemoryVersion: null, kind: 'FACT', candidate: '{}' }), '23514', 'target_version_consistency');
      await rejected(client, () => insert(client, 'EvidenceRecord', { id: randomUUID(), ideaId: f.idea, origin: 'USER_REPORT', trust: 'SOURCE_CHECKED', finding: 'synthetic' }), '23514', 'checked_source_requires_provenance');
      await rejected(client, () => insert(client, 'Experiment', { id: randomUUID(), ideaId: f.idea, hypothesis: 'synthetic', plan: '{"title":42}', successCriteria: '{}', updatedAt: new Date() }), '23514', 'experiment_plan_title_shape');
      await rejected(client, () => insert(client, 'DocumentSnapshot', { id: randomUUID(), ideaId: f.idea, version: 1, status: 'APPROVED', content: '{}', updatedAt: new Date() }), '23514', 'approval_requires_metadata');
    });
  });

  await t.test('immutable history, approved snapshots, legacy markers and 20-link capture bounds', async () => {
    await transaction(values.TEST_DATABASE_URL, async client => {
      const f = await fixture(client), memory = randomUUID(), revision = randomUUID(), snapshot = randomUUID(), learning = randomUUID(), legacy = randomUUID();
      await insert(client, 'ConfirmedMemory', { id: memory, ideaId: f.idea, kind: 'FACT', currentContent: '{}', updatedAt: new Date() });
      await insert(client, 'MemoryRevision', { id: revision, memoryId: memory, version: 1, content: '{}', actorId: f.owner });
      await insert(client, 'DocumentSnapshot', { id: snapshot, ideaId: f.idea, version: 1, status: 'APPROVED', content: '{}', contentSha256: hash, approvedAt: new Date(), approvedById: f.owner, updatedAt: new Date() });
      for (const [id, evidenceLinksRecorded] of [[learning, true], [legacy, false]]) await insert(client, 'Learning', { id, ideaId: f.idea, interpretation: 'synthetic', approvedById: f.owner, evidenceLinksRecorded });
      await rejected(client, () => client.query('UPDATE "MemoryRevision" SET content=\'{}\' WHERE id=$1', [revision]), 'P0001');
      await rejected(client, () => client.query('UPDATE "DocumentSnapshot" SET content=\'{}\' WHERE id=$1', [snapshot]), 'P0001');
      await rejected(client, () => client.query('UPDATE "Learning" SET "evidenceLinksRecorded"=true WHERE id=$1', [legacy]), 'P0001');
      await rejected(client, () => client.query('UPDATE "Learning" SET "evidenceLinksRecorded"=false WHERE id=$1', [learning]), 'P0001');
      assert.deepEqual((await client.query('SELECT observation,"evidenceLinksRecorded" FROM "Learning" WHERE id=$1', [legacy])).rows[0], { observation: null, evidenceLinksRecorded: false });
      let firstEvidence;
      for (let index = 0; index < 21; index++) {
        const evidence = randomUUID();
        firstEvidence ??= evidence;
        await insert(client, 'EvidenceRecord', { id: evidence, ideaId: f.idea, origin: 'USER_REPORT', finding: 'synthetic' });
        if (index < 20) await insert(client, 'LearningEvidence', { ideaId: f.idea, learningId: learning, evidenceId: evidence });
        else await rejected(client, () => insert(client, 'LearningEvidence', { ideaId: f.idea, learningId: learning, evidenceId: evidence }), 'P0001');
        if (index === 0) {
          await rejected(client, () => insert(client, 'LearningEvidence', { ideaId: f.idea, learningId: learning, evidenceId: evidence }), '23505');
          await rejected(client, () => insert(client, 'LearningEvidence', { ideaId: f.idea, learningId: legacy, evidenceId: evidence }), 'P0001');
        }
      }
      assert.equal((await client.query('SELECT count(*)::int AS count FROM "LearningEvidence" WHERE "learningId"=$1', [learning])).rows[0].count, 20);
      await rejected(client, () => client.query('UPDATE "LearningEvidence" SET "evidenceId"=$1 WHERE "learningId"=$2', [firstEvidence, learning]), 'P0001');
      const foreignEvidence = randomUUID();
      await insert(client, 'EvidenceRecord', { id: foreignEvidence, ideaId: f.otherIdea, origin: 'USER_REPORT', finding: 'synthetic' });
      const fresh = randomUUID();
      await insert(client, 'Learning', { id: fresh, ideaId: f.idea, interpretation: 'synthetic', approvedById: f.owner, evidenceLinksRecorded: true });
      await rejected(client, () => insert(client, 'LearningEvidence', { ideaId: f.idea, learningId: fresh, evidenceId: foreignEvidence }), '23503');
    });
    // Owner privileges cannot bypass the immutable triggers either.
    await transaction(values.TEST_MIGRATION_DATABASE_URL, async client => {
      const f = await fixture(client), learning = randomUUID(), memory = randomUUID(), revision = randomUUID(), evidence = randomUUID(), snapshot = randomUUID();
      await insert(client, 'Learning', { id: learning, ideaId: f.idea, interpretation: 'synthetic', approvedById: f.owner, evidenceLinksRecorded: true });
      await insert(client, 'ConfirmedMemory', { id: memory, ideaId: f.idea, kind: 'FACT', currentContent: '{}', updatedAt: new Date() });
      await insert(client, 'MemoryRevision', { id: revision, memoryId: memory, version: 1, content: '{}', actorId: f.owner });
      await insert(client, 'EvidenceRecord', { id: evidence, ideaId: f.idea, origin: 'USER_REPORT', finding: 'synthetic' });
      await insert(client, 'LearningEvidence', { ideaId: f.idea, learningId: learning, evidenceId: evidence });
      await insert(client, 'DocumentSnapshot', { id: snapshot, ideaId: f.idea, version: 1, status: 'APPROVED', content: '{}', contentSha256: hash, approvedAt: new Date(), approvedById: f.owner, updatedAt: new Date() });
      await rejected(client, () => client.query('DELETE FROM "Learning" WHERE id=$1', [learning]), 'P0001');
      await rejected(client, () => client.query('DELETE FROM "MemoryRevision" WHERE id=$1', [revision]), 'P0001');
      await rejected(client, () => client.query('DELETE FROM "LearningEvidence" WHERE "learningId"=$1', [learning]), 'P0001');
      await rejected(client, () => client.query('DELETE FROM "DocumentSnapshot" WHERE id=$1', [snapshot]), 'P0001');
    });
  });

  await t.test('PrismaPg uses the restricted identity and rolls back account, idea and outbox atomically', async () => {
    const prisma = createDatabaseClient({ DATABASE_URL: values.TEST_DATABASE_URL });
    const id = randomUUID(), outbox = randomUUID(), learning = randomUUID(), sentinel = new Error('synthetic transaction rollback');
    try {
      await assert.rejects(prisma.$transaction(async tx => {
        const identity = await tx.$queryRaw`SELECT current_user AS name`;
        assert.equal(identity[0].name, 'fl_m02_runtime');
        const owner = await tx.userAccount.create({ data: { id, clerkSubject: 'm02-synthetic-' + id, clerkInstanceId: 'm02-synthetic', subjectKey: id.replaceAll('-', '').repeat(2) } });
        await tx.idea.create({ data: { ownerId: owner.id, title: 'synthetic Prisma transaction' } });
        await tx.outboxEvent.create({ data: { id: outbox, kind: 'm02.synthetic', aggregateType: 'synthetic', aggregateId: id, payload: {} } });
        throw sentinel;
      }), error => error === sentinel);
      assert.equal(await prisma.userAccount.count({ where: { id } }), 0);
      assert.equal(await prisma.outboxEvent.count({ where: { id: outbox } }), 0);
      await assert.rejects(prisma.$transaction(async tx => {
        const owner = await tx.userAccount.create({ data: { id, clerkSubject: 'm02-synthetic-' + id, clerkInstanceId: 'm02-synthetic', subjectKey: id.replaceAll('-', '').repeat(2) } });
        const idea = await tx.idea.create({ data: { ownerId: owner.id, title: 'synthetic learning rollback' } });
        await tx.learning.create({ data: { id: learning, ideaId: idea.id, interpretation: 'synthetic', approvedById: owner.id, evidenceLinksRecorded: true } });
        const evidence = await tx.evidenceRecord.create({ data: { ideaId: idea.id, origin: 'USER_REPORT', finding: 'synthetic' } });
        await tx.learningEvidence.create({ data: { ideaId: idea.id, learningId: learning, evidenceId: evidence.id } });
        await tx.outboxEvent.create({ data: { id: outbox, kind: 'm02.synthetic', aggregateType: 'synthetic', aggregateId: id, payload: {} } });
        // A later FK failure must roll back parent, captured link and receipt together.
        await tx.learningEvidence.create({ data: { ideaId: idea.id, learningId: learning, evidenceId: randomUUID() } });
      }), error => error.code === 'P2003');
      assert.equal(await prisma.learning.count({ where: { id: learning } }), 0);
      assert.equal(await prisma.learningEvidence.count({ where: { learningId: learning } }), 0);
      assert.equal(await prisma.outboxEvent.count({ where: { id: outbox } }), 0);
      assert.equal(await prisma.userAccount.count({ where: { id } }), 0);
    } finally { await prisma.$disconnect(); }
  });

  await t.test('20 independent connections contend for exactly one active generation', async () => {
    const owner = connection(values.TEST_MIGRATION_DATABASE_URL);
    await owner.connect();
    let f;
    try {
      await owner.query('BEGIN');
      f = await fixture(owner);
      await owner.query('COMMIT');
      const clients = Array.from({ length: 20 }, () => connection(values.TEST_DATABASE_URL));
      try {
        await Promise.all(clients.map(client => client.connect()));
        const results = await Promise.allSettled(clients.map((client, index) => insert(client, 'GenerationAttempt', attempt(f, index + 1))));
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
        for (const result of results.filter(result => result.status === 'rejected')) {
          assert.equal(result.reason.code, '23505');
          assert.equal(result.reason.constraint, 'GenerationAttempt_one_active_per_conversation');
        }
        assert.equal((await owner.query('SELECT count(*)::int AS count FROM "GenerationAttempt" WHERE "conversationId"=$1', [f.conversation])).rows[0].count, 1);
      } finally { await Promise.all(clients.map(client => client.end())); }
    } finally {
      await owner.query('ROLLBACK');
      if (f) {
        // Only these newly created synthetic IDs are eligible for fixture cleanup.
        await owner.query('BEGIN');
        try {
          await owner.query('DELETE FROM "GenerationAttempt" WHERE "conversationId"=$1', [f.conversation]);
          await owner.query('DELETE FROM "Message" WHERE id=$1', [f.message]);
          await owner.query('DELETE FROM "Conversation" WHERE id=ANY($1::uuid[])', [[f.conversation, f.otherConversation]]);
          await owner.query('DELETE FROM "Idea" WHERE id=ANY($1::uuid[])', [[f.idea, f.otherIdea]]);
          await owner.query('DELETE FROM "UserAccount" WHERE id=ANY($1::uuid[])', [[f.owner, f.otherOwner]]);
          await owner.query('COMMIT');
        } catch (error) { await owner.query('ROLLBACK'); throw error; }
      }
      await owner.end();
    }
  });

  await t.test('all synthetic records were removed or rolled back; baseline file still matches', async () => {
    await transaction(values.TEST_MIGRATION_DATABASE_URL, async client => {
      assert.equal((await client.query('SELECT count(*)::int AS count FROM "UserAccount" WHERE "clerkInstanceId"=\'m02-synthetic\'')).rows[0].count, 0);
    });
    assert.equal((await reviewedMigration()).checksum, checksum);
    assert.ok((await readFile(path.join(root, migrationPath))).length > 40_000);
  });
});
