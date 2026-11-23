/** Create only the fixed disposable Cedar target. Stop on any existing resource or unexpected identity. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { Redis } from 'ioredis';
import { cedarAcceptanceTarget, cedarRecheckTarget } from '../apps/api/dist/generation/cedar-acceptance-target.js';
import { createSuppressionLedger } from '../apps/api/dist/security/suppression-ledger.js';

const recheck = process.env.FL_P9_CEDAR_ACCEPTANCE === '2';
const target = recheck ? cedarRecheckTarget : cedarAcceptanceTarget;
const project = recheck ? 'fl-p9-cedar-recheck' : 'fl-p9-cedar-acceptance';
const root = recheck ? '.env.p9-cedar-recheck-' : '.env.p9-cedar-';
const files = [root + 'primary.operator.local', root + 'primary.runtime.local', root + 'api.local', root + 'worker.local'];
const roles = {
  fl_p6_workspace: 'FL_P6_WORKSPACE_PASSWORD', fl_p6_provision: 'FL_P6_PROVISION_PASSWORD',
  fl_p8_conversations: 'FL_P8_CONVERSATIONS_PASSWORD', fl_p9_submit: 'FL_P9_SUBMIT_PASSWORD',
  fl_p9_dispatch: 'CEDAR_DISPATCH_PASSWORD', fl_p9_context_verifier: 'CEDAR_VERIFIER_PASSWORD',
  fl_p9_worker: 'CEDAR_WORKER_PASSWORD'
};
const fresh = () => randomBytes(32).toString('hex');
const docker = (args, env = process.env, input) => {
  const command = spawnSync('docker', ['--context', 'desktop-linux', ...args], { env, input, encoding: 'utf8', timeout: 90_000 });
  assert.ok(command.status === 0, 'Cedar Docker command failed');
  return command.stdout.trim();
};
const save = (path, values) => writeFile(path, Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n',
  { flag: 'wx', mode: 0o600 });

async function verifyPort(port) {
  const socket = createServer();
  await new Promise((resolve, reject) => socket.once('error', reject).listen({ host: '127.0.0.1', port, exclusive: true }, resolve));
  await new Promise(resolve => socket.close(resolve));
}

async function storeIdentity(pool) {
  const { rows } = await pool.query(`SELECT system_identifier::text AS cluster, oid::text AS oid
    FROM pg_catalog.pg_control_system(), pg_catalog.pg_database WHERE datname=current_database()`);
  return rows[0];
}

async function waitForStore(pool) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const id = await storeIdentity(pool).catch(() => undefined);
    if (id) return id;
    await sleep(1000);
  }
  throw new Error('Cedar database did not become ready');
}

const pools = [];
let redis;
try {
  assert.ok(process.env.NODE_ENV !== 'production' && process.env.FL_P9_CEDAR_BOOTSTRAP_CONFIRM === 'create-one-disposable-cedar-target',
    'Cedar bootstrap authorization required');
  assert.ok([undefined, '1', '2'].includes(process.env.FL_P9_CEDAR_ACCEPTANCE), 'Invalid Cedar profile');
  for (const file of files) {
    assert.ok(!existsSync(file) && spawnSync('git', ['check-ignore', '-q', '--', file]).status === 0,
      'Cedar local configuration already exists or is not ignored');
  }
  assert.equal(docker(['info', '--format', '{{.OSType}}']), 'linux');
  assert.ok(!docker(['ps', '-a', '--filter', 'name=' + project, '--format', '{{.ID}}']) &&
    !docker(['volume', 'ls', '--filter', 'name=' + project, '-q']), 'Cedar Docker resources already exist');
  await Promise.all([target.primaryPort, target.authorityPort, target.redisPort].map(verifyPort));
  const historicalFiles = ['.env.p9-primary.runtime.local', ...(recheck ? ['.env.p9-cedar-primary.runtime.local'] : [])];
  const historicalClusters = new Set();
  for (const file of historicalFiles) {
    const priorEnv = parseEnv(await readFile(file, 'utf8'));
    const prior = JSON.parse(Buffer.from(priorEnv.FL_P6_GENESIS, 'base64url').toString('utf8')).record;
    historicalClusters.add(prior.primary.cluster);
    historicalClusters.add(prior.authority.cluster);
  }
  const env = Object.fromEntries([...Object.values(roles), 'FL_P6_PRIMARY_ADMIN_PASSWORD', 'FL_SUPPRESSION_ADMIN_PASSWORD',
    'FL_SUPPRESSION_READER_PASSWORD', 'FL_SUPPRESSION_WRITER_PASSWORD', 'FL_P6_INTEGRITY_KEY', 'FL_P6_CHALLENGE_KEY',
    'FL_P6_SUBJECT_KEY_V1', 'FL_P6_GENESIS_KEY', 'CEDAR_REDIS_PASSWORD'].map(name => [name, fresh()]));
  await save(files[0], env);
  const compose = (await readFile('tests/fixtures/p9-cedar-acceptance.compose.yaml', 'utf8'))
    .replaceAll('fl-p9-cedar-acceptance', project).replaceAll(cedarAcceptanceTarget.database, target.database)
    .replaceAll(String(cedarAcceptanceTarget.primaryPort), String(target.primaryPort))
    .replaceAll(String(cedarAcceptanceTarget.authorityPort), String(target.authorityPort))
    .replaceAll(String(cedarAcceptanceTarget.redisPort), String(target.redisPort));
  docker(['compose', '--project-directory', 'tests/fixtures', '-f', '-', 'up', '-d', '--pull', 'never'],
    { ...process.env, ...env }, compose);
  for (const [service, port, internal, path] of [
    ['primary', target.primaryPort, '5432/tcp', '/var/lib/postgresql/data'],
    ['authority', target.authorityPort, '5432/tcp', '/var/lib/postgresql/data'],
    ['redis', target.redisPort, '6379/tcp', '/data']
  ]) {
    const [resource] = JSON.parse(docker(['inspect', `${project}-${service}-1`]));
    const binding = resource.HostConfig.PortBindings[internal];
    assert.ok(resource.Config.Labels['com.docker.compose.project'] === project && binding?.length === 1 &&
      binding[0].HostIp === '127.0.0.1' && binding[0].HostPort === String(port) &&
      resource.Mounts.some(mount => mount.Name === `${project}_${service}-data` && mount.Destination === path),
    'Cedar Docker isolation could not be verified');
  }
  const pool = (port, database, user, password) => {
    const client = new pg.Pool({ host: '127.0.0.1', port, database, user, password, connectionTimeoutMillis: 1000 });
    pools.push(client);
    return client;
  };
  const primary = pool(target.primaryPort, target.database, 'postgres', env.FL_P6_PRIMARY_ADMIN_PASSWORD);
  const authority = pool(target.authorityPort, 'suppression_proof', 'postgres', env.FL_SUPPRESSION_ADMIN_PASSWORD);
  const [primaryId, authorityId] = await Promise.all([waitForStore(primary), waitForStore(authority)]);
  assert.ok(primaryId.cluster !== authorityId.cluster && !historicalClusters.has(primaryId.cluster) && !historicalClusters.has(authorityId.cluster),
    'Cedar target does not have independent cluster identities');
  const pgUrl = (port, database, user, password) => `postgresql://${user}:${password}@127.0.0.1:${port}/${database}`;
  const migration = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--config', 'prisma.config.ts'],
    { env: { ...process.env, SHADOW_DATABASE_URL: '', MIGRATION_DATABASE_URL: pgUrl(target.primaryPort, target.database, 'postgres',
      env.FL_P6_PRIMARY_ADMIN_PASSWORD) }, stdio: 'ignore', timeout: 60_000 });
  assert.ok(migration.status === 0, 'Cedar migrations did not apply');
  for (const [role, name] of Object.entries(roles)) {
    await primary.query(`CREATE ROLE ${role} LOGIN NOINHERIT PASSWORD '${env[name]}'`);
  }
  for (const grants of ['tests/fixtures/p6-primary-grants.sql', 'tests/fixtures/p8-conversation-grants.sql']) {
    await primary.query((await readFile(grants, 'utf8')).replaceAll('founders_lens_p6_local', target.database));
  }
  await primary.query(`GRANT CONNECT ON DATABASE ${target.database} TO fl_p9_submit, fl_p9_dispatch, fl_p9_worker, fl_p9_context_verifier`);
  await primary.query(await readFile('scripts/p9-local-runtime-grants.sql', 'utf8'));
  await primary.query('ALTER ROLE fl_p6_provision NOLOGIN PASSWORD NULL');
  await authority.query(`REVOKE CONNECT, TEMPORARY ON DATABASE postgres,template1 FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO ledger_reader`);
  const mac = (key, data) => createHmac('sha256', Buffer.from(key, 'hex')).update(JSON.stringify(data)).digest('hex');
  const epoch = randomUUID(), subjectVersions = [1];
  const namespace = 'hmac-sha256-v1:' + mac(env.FL_P6_CHALLENGE_KEY, ['deletion-challenge-namespace-v1']);
  await authority.query('INSERT INTO authority.coverage(singleton,epoch,integrity,subject_versions,challenge_namespace) VALUES(true,$1,$2,$3,$4)',
    [epoch, mac(env.FL_P6_INTEGRITY_KEY, ['suppression-coverage-v2', epoch, subjectVersions, namespace]), subjectVersions, namespace]);
  const reader = pool(target.authorityPort, 'suppression_proof', 'ledger_reader', env.FL_SUPPRESSION_READER_PASSWORD);
  const ledger = createSuppressionLedger(reader, { epoch, challengeNamespace: namespace, subjectVersions,
    integrityKey: Buffer.from(env.FL_P6_INTEGRITY_KEY, 'hex') });
  const snapshot = await ledger.runtimeSnapshot();
  assert.deepEqual(await ledger.inventory(), []);
  const redisUrl = `redis://:${env.CEDAR_REDIS_PASSWORD}@127.0.0.1:${target.redisPort}/0`;
  redis = new Redis(redisUrl, { lazyConnect: true, connectTimeout: 1000, retryStrategy: () => null, maxRetriesPerRequest: 0 });
  redis.on('error', () => {});
  assert.equal(await redis.ping(), 'PONG');
  const record = { version: 1, primary: primaryId, authority: authorityId, epoch, namespace, subjectVersions,
    inventoryDigest: snapshot.inventoryDigest };
  const shared = { FL_P6_AUTHORITY_EPOCH: epoch, FL_P6_AUTHORITY_NAMESPACE: namespace, FL_P6_INTEGRITY_KEY: env.FL_P6_INTEGRITY_KEY };
  const api = { ...shared, FL_P6_WORKSPACE_PASSWORD: env.FL_P6_WORKSPACE_PASSWORD, FL_P6_SUBJECT_KEY_V1: env.FL_P6_SUBJECT_KEY_V1,
    FL_SUPPRESSION_READER_PASSWORD: env.FL_SUPPRESSION_READER_PASSWORD, FL_P8_CONVERSATIONS_PASSWORD: env.FL_P8_CONVERSATIONS_PASSWORD,
    FL_P9_SUBMIT_PASSWORD: env.FL_P9_SUBMIT_PASSWORD };
  await save(files[1], { ...api, FL_P6_GENESIS: Buffer.from(JSON.stringify({ record,
    integrity: mac(env.FL_P6_GENESIS_KEY, ['p6-fresh-genesis-v1', record]) })).toString('base64url') });
  await save(files[2], api);
  await save(files[3], { ...shared, FL_P9_RETAINED_VERSIONS: '1', FL_P9_REDIS_URL: redisUrl,
    FL_P9_AUTHORITY_DATABASE_URL: pgUrl(target.authorityPort, 'suppression_proof', 'ledger_reader', env.FL_SUPPRESSION_READER_PASSWORD),
    FL_P9_DISPATCH_DATABASE_URL: pgUrl(target.primaryPort, target.database, 'fl_p9_dispatch', env.CEDAR_DISPATCH_PASSWORD),
    FL_P9_VERIFIER_DATABASE_URL: pgUrl(target.primaryPort, target.database, 'fl_p9_context_verifier', env.CEDAR_VERIFIER_PASSWORD),
    FL_P9_WORKER_DATABASE_URL: pgUrl(target.primaryPort, target.database, 'fl_p9_worker', env.CEDAR_WORKER_PASSWORD) });
  console.log(JSON.stringify({ primary: primaryId, authority: authorityId, redis: 'READY' }));
} catch {
  console.error('Cedar bootstrap stopped. Inspect only the Cedar project before attempting recovery.');
  process.exitCode = 1;
} finally {
  redis?.disconnect();
  await Promise.all(pools.map(pool => pool.end()));
}
