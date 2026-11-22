// Explicit P6 bootstrap and repeatable verification for the approved persistent
// stores. Default tests never connect to these databases or change trust state.
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import test from 'node:test';
import { Pool } from 'pg';
import { createApp } from '../apps/api/dist/app.js';
import { createSuppressionLedger } from '../apps/api/dist/security/suppression-ledger.js';

const bootstrap = process.argv.includes('--p6-bootstrap-genesis');
const resume = process.argv.includes('--p6-resume-verified-bootstrap');
const verify = process.argv.includes('--p6-local-verify');
const migration = '0001_approved_baseline';
const migrationFile = 'apps/api/prisma/migrations/' + migration + '/migration.sql';
const runtimeFile = '.env.p6.runtime.local';
const image = 'docker.io/library/postgres:17.12-bookworm@sha256:40865bc877a289da75963d97d72b59633f639fc5af7a4e856bfa3714cae5b536';
const denied = { code: '42501' };

/** Require an exact, local P6 container and data volume before connecting. */
function inspect(service, port) {
  const name = 'fl-p6-local-' + service + '-1';
  const result = spawnSync('docker', ['inspect', name], { encoding: 'utf8', timeout: 5000 });
  assert.ok(result.status === 0, 'P6 container unavailable');
  const [container] = JSON.parse(result.stdout);
  const volume = 'fl-p6-local_' + service + '-data';
  assert.ok(container.Name === '/' + name && container.Config.Image === image &&
    container.State.Health?.Status === 'healthy' &&
    container.Config.Labels['com.docker.compose.project'] === 'fl-p6-local' &&
    container.Config.Labels['com.docker.compose.service'] === service &&
    container.Mounts.some(mount => mount.Type === 'volume' && mount.Name === volume &&
      mount.Destination === '/var/lib/postgresql/data') &&
    JSON.stringify(container.HostConfig.PortBindings['5432/tcp']) === JSON.stringify([{ HostIp: '127.0.0.1', HostPort: String(port) }]),
  'P6 ownership, image, health or binding mismatch');
  return { container: container.Id, volume };
}

/** Read the exact PostgreSQL control identity and version from the selected role. */
async function identity(pool) {
  return (await pool.query(`SELECT system_identifier::text AS cluster, oid::text AS oid,
    current_database() AS database, current_user AS role, current_setting('server_version_num') AS version
    FROM pg_catalog.pg_control_system(), pg_catalog.pg_database WHERE datname=current_database()`)).rows[0];
}

/** Check the approved migration was applied and record no founder data. */
async function checkPrimary(admin, checksum) {
  const ledger = (await admin.query('SELECT migration_name,checksum,finished_at,rolled_back_at FROM "_prisma_migrations"')).rows;
  assert.ok(ledger.length === 1 && ledger[0].migration_name === migration && ledger[0].checksum === checksum &&
    ledger[0].finished_at && !ledger[0].rolled_back_at, 'Primary migration provenance unavailable');
  const counts = (await admin.query(`SELECT (SELECT count(*)::int FROM "UserAccount") AS accounts,
    (SELECT count(*)::int FROM "Idea") AS ideas,(SELECT count(*)::int FROM "Conversation") AS conversations,
    (SELECT count(*)::int FROM "Message") AS messages,(SELECT count(*)::int FROM "DataOperation") AS operations,
    (SELECT count(*)::int FROM "IdentityTombstone") AS tombstones`)).rows[0];
  assert.ok(Object.values(counts).every(n => n === 0), 'The unbound P6 genesis must not contain application rows');
  return counts;
}

/** Exercise actual permitted queries and confirm write and content permissions stay narrow. */
async function verifyGrants(workspace, provision, authorityReader, authorityWriter) {
  const tx = await workspace.connect();
  try {
    await tx.query('BEGIN');
    for (const table of ['UserAccount', 'Idea']) await tx.query('SELECT id FROM "' + table + '" FOR UPDATE');
    await tx.query('SELECT id,"subjectKeyVersion",status FROM "UserAccount"');
    await tx.query('SELECT id,"ownerId",title,summary,status,version,"createdAt","updatedAt" FROM "Idea"');
    await tx.query('SELECT id,kind,"ownerSubjectKey","subjectKeyVersion","ideaId" FROM "DataOperation"');
    await tx.query('SELECT id,"subjectKey","subjectKeyVersion" FROM "IdentityTombstone"');
    await tx.query('ROLLBACK');
  } finally { tx.release(); }
  for (const statement of ['SELECT content FROM "Message" LIMIT 0',
    'EXPLAIN INSERT INTO "UserAccount" DEFAULT VALUES', 'EXPLAIN DELETE FROM "Idea" WHERE false',
    'EXPLAIN UPDATE "Idea" SET title=title WHERE false', 'SELECT * FROM "_prisma_migrations" LIMIT 0']) {
    await assert.rejects(workspace.query(statement), denied);
  }
  const grants = (await workspace.query(`SELECT
    has_schema_privilege(current_user,'public','CREATE') AS ddl,
    has_column_privilege(current_user,'public."Idea"','updatedAt','UPDATE') AS lock,
    has_column_privilege(current_user,'public."UserAccount"','subjectKey','UPDATE') AS rekey`)).rows[0];
  assert.deepEqual(grants, { ddl: false, lock: true, rekey: false });
  const provisioning = (await provision.query(`SELECT
    has_column_privilege(current_user,'public."UserAccount"','clerkSubject','INSERT') AS bind,
    has_column_privilege(current_user,'public."UserAccount"','subjectKey','UPDATE') AS rekey,
    has_any_column_privilege(current_user,'public."Idea"','INSERT') AS seed`)).rows[0];
  assert.deepEqual(provisioning, { bind: true, rekey: false, seed: false });
  await assert.rejects(authorityReader.query('EXPLAIN INSERT INTO authority.intent DEFAULT VALUES'), denied);
  await assert.rejects(authorityWriter.query('EXPLAIN UPDATE authority.coverage SET recovery_run=NULL'), denied);
  await assert.rejects(authorityWriter.query('EXPLAIN DELETE FROM authority.intent'), denied);
}

test('P6 persistent genesis and restricted roles', { skip: !bootstrap && !verify, timeout: 120_000 }, async t => {
  assert.ok(bootstrap !== verify && (!resume || bootstrap), 'Select one P6 mode');
  const resources = { primary: inspect('primary', 55437), authority: inspect('authority', 55436) };
  const env = process.env;
  const required = ['FL_P6_PRIMARY_ADMIN_PASSWORD', 'FL_SUPPRESSION_ADMIN_PASSWORD', 'FL_SUPPRESSION_READER_PASSWORD',
    'FL_SUPPRESSION_WRITER_PASSWORD', 'FL_P6_WORKSPACE_PASSWORD', 'FL_P6_PROVISION_PASSWORD',
    'FL_P6_INTEGRITY_KEY', 'FL_P6_CHALLENGE_KEY', 'FL_P6_SUBJECT_KEY_V1', 'FL_P6_GENESIS_KEY'];
  const secrets = required.map(name => env[name]);
  assert.ok(secrets.every(value => /^[0-9a-f]{64}$/.test(value ?? '')) &&
    new Set(secrets).size === secrets.length, 'Independent P6 credentials and keys are required');

  const pools = [];
  const connect = (port, database, user, password) => {
    const pool = new Pool({ host: '127.0.0.1', port, database, user, password,
      connectionTimeoutMillis: 1500, statement_timeout: 4000, query_timeout: 5000 });
    pools.push(pool);
    return pool;
  };
  // This persistent environment belongs to the operator. End only this process's connections.
  t.after(() => Promise.all(pools.map(pool => pool.end())));
  const primary = connect(55437, 'founders_lens_p6_local', 'postgres', env.FL_P6_PRIMARY_ADMIN_PASSWORD);
  const authorityAdmin = connect(55436, 'suppression_proof', 'postgres', env.FL_SUPPRESSION_ADMIN_PASSWORD);
  const workspace = connect(55437, 'founders_lens_p6_local', 'fl_p6_workspace', env.FL_P6_WORKSPACE_PASSWORD);
  const provision = connect(55437, 'founders_lens_p6_local', 'fl_p6_provision', env.FL_P6_PROVISION_PASSWORD);
  const authorityReader = connect(55436, 'suppression_proof', 'ledger_reader', env.FL_SUPPRESSION_READER_PASSWORD);
  const authorityWriter = connect(55436, 'suppression_proof', 'ledger_writer', env.FL_SUPPRESSION_WRITER_PASSWORD);
  const primaryId = await identity(primary), authorityId = await identity(authorityAdmin);
  assert.ok(primaryId.cluster !== authorityId.cluster && primaryId.version === '170012' && authorityId.version === '170012',
    'P6 stores are not the expected distinct PostgreSQL 17.12 clusters');
  const bytes = await readFile(migrationFile);
  const baseline = spawnSync('git', ['show', 'HEAD:' + migrationFile], { encoding: 'utf8' });
  assert.ok(baseline.status === 0 && bytes.toString().replaceAll('\r\n', '\n') === baseline.stdout.replaceAll('\r\n', '\n'),
    'Migration differs from the committed baseline');
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const mac = (key, data) => createHmac('sha256', Buffer.from(key, 'hex')).update(JSON.stringify(data)).digest('hex');
  const namespace = 'hmac-sha256-v1:' + mac(env.FL_P6_CHALLENGE_KEY, ['deletion-challenge-namespace-v1']);
  const subjectVersions = [1];

  let record;
  if (bootstrap) {
    await assert.rejects(readFile(runtimeFile), { code: 'ENOENT' });
    // The new clusters must not contain a database import or preexisting coverage.
    const before = (await primary.query(`SELECT count(*)::int AS total FROM pg_catalog.pg_tables WHERE schemaname='public'`)).rows[0].total;
    const prior = (await authorityAdmin.query(`SELECT (SELECT count(*)::int FROM authority.coverage) AS coverage,
      (SELECT count(*)::int FROM authority.intent) AS intents,
      (SELECT count(*)::int FROM authority.recovery_progress) AS progress`)).rows[0];
    assert.deepEqual(prior, { coverage: 0, intents: 0, progress: 0 });
    if (resume) {
      // An operator may resume only a bootstrap whose fresh initialization they
      // observed. These pins prevent resuming onto a replacement container.
      assert.ok(env.FL_P6_VERIFIED_PRIMARY_CONTAINER === resources.primary.container &&
        env.FL_P6_VERIFIED_AUTHORITY_CONTAINER === resources.authority.container,
      'Operator-confirmed bootstrap identities are required to resume');
    } else {
      assert.equal(before, 0);
      const migrationUrl = new URL('postgresql://postgres@127.0.0.1:55437/founders_lens_p6_local');
      migrationUrl.password = env.FL_P6_PRIMARY_ADMIN_PASSWORD;
      const applied = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--config', 'prisma.config.ts'],
        { env: { ...env, MIGRATION_DATABASE_URL: migrationUrl.href }, stdio: 'ignore', timeout: 60_000 });
      assert.ok(applied.status === 0, 'Approved baseline migration failed');
      await primary.query(`BEGIN;
        CREATE ROLE fl_p6_workspace LOGIN NOINHERIT PASSWORD '${env.FL_P6_WORKSPACE_PASSWORD}';
        CREATE ROLE fl_p6_provision LOGIN NOINHERIT PASSWORD '${env.FL_P6_PROVISION_PASSWORD}';
        ${await readFile('tests/fixtures/p6-primary-grants.sql', 'utf8')}
        COMMIT;`);
      await authorityAdmin.query(`REVOKE CONNECT, TEMPORARY ON DATABASE postgres,template1 FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO ledger_reader`);
    }
    const counts = await checkPrimary(primary, checksum);
    await verifyGrants(workspace, provision, authorityReader, authorityWriter);
    const epoch = randomUUID();
    const seal = mac(env.FL_P6_INTEGRITY_KEY, ['suppression-coverage-v2', epoch, subjectVersions, namespace]);
    await authorityAdmin.query('INSERT INTO authority.coverage(singleton,epoch,integrity,subject_versions,challenge_namespace) VALUES(true,$1,$2,$3,$4)',
      [epoch, seal, subjectVersions, namespace]);
    const ledger = createSuppressionLedger(authorityReader, { epoch, challengeNamespace: namespace, subjectVersions,
      integrityKey: Buffer.from(env.FL_P6_INTEGRITY_KEY, 'hex') });
    assert.deepEqual(await ledger.inventory(), []);
    const snapshot = await ledger.runtimeSnapshot();
    // Preserve the bootstrap observation separately from both database volumes.
    // This is genesis evidence, not an Ed25519 runtime clearance decision.
    record = { version: 1, resources, primary: primaryId, authority: authorityId, migration, checksum,
      counts, epoch, namespace, subjectVersions, inventoryDigest: snapshot.inventoryDigest };
    const provenance = { record, integrity: mac(env.FL_P6_GENESIS_KEY, ['p6-fresh-genesis-v1', record]) };
    const runtimeEnv = [
      'FL_P6_WORKSPACE_PASSWORD=' + env.FL_P6_WORKSPACE_PASSWORD,
      'FL_SUPPRESSION_READER_PASSWORD=' + env.FL_SUPPRESSION_READER_PASSWORD,
      'FL_P6_INTEGRITY_KEY=' + env.FL_P6_INTEGRITY_KEY,
      'FL_P6_SUBJECT_KEY_V1=' + env.FL_P6_SUBJECT_KEY_V1,
      'FL_P6_AUTHORITY_EPOCH=' + epoch, 'FL_P6_AUTHORITY_NAMESPACE=' + namespace,
      'FL_P6_GENESIS=' + Buffer.from(JSON.stringify(provenance)).toString('base64url'), ''
    ].join('\n');
    await writeFile(runtimeFile, runtimeEnv, { flag: 'wx', mode: 0o600 });
  } else {
    const local = parseEnv(await readFile(runtimeFile, 'utf8'));
    const provenance = JSON.parse(Buffer.from(local.FL_P6_GENESIS, 'base64url').toString('utf8'));
    record = provenance.record;
    assert.ok(provenance.integrity === mac(env.FL_P6_GENESIS_KEY, ['p6-fresh-genesis-v1', record]),
      'Genesis evidence did not authenticate');
    assert.deepEqual(record.resources, resources);
    assert.deepEqual(record.primary, primaryId);
    assert.deepEqual(record.authority, authorityId);
    assert.equal(record.checksum, checksum);
    await checkPrimary(primary, checksum);
    await verifyGrants(workspace, provision, authorityReader, authorityWriter);
    const ledger = createSuppressionLedger(authorityReader, { epoch: local.FL_P6_AUTHORITY_EPOCH,
      challengeNamespace: local.FL_P6_AUTHORITY_NAMESPACE, subjectVersions, integrityKey: Buffer.from(env.FL_P6_INTEGRITY_KEY, 'hex') });
    const snapshot = await ledger.runtimeSnapshot();
    assert.ok(snapshot.inventoryDigest === record.inventoryDigest && snapshot.epoch === record.epoch &&
      snapshot.namespace === record.namespace && (await ledger.inventory()).length === 0, 'Authority no longer matches genesis');
  }
  assert.ok((await identity(workspace)).role === 'fl_p6_workspace');
  assert.ok((await identity(authorityReader)).role === 'ledger_reader');
  console.info('Verified P6 identities and genesis counts:', { resources, primary: primaryId, authority: authorityId,
    migration, checksum, counts: record.counts });
});

test('default Express application remains guarded', async t => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(origin + '/health/ready')).status, 503);
  assert.equal((await fetch(origin + '/api/v1/ideas')).status, 404);
});
