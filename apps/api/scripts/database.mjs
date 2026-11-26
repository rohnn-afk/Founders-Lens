// Local database administration CLI. Unlike the restricted runtime Prisma
// Client, it manages setup. Plan only reads inventory. Provision creates
// roles and databases, and migrate applies the reviewed sequence and grants.
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import pg from 'pg';

export const root = fileURLToPath(new URL('../../../', import.meta.url));
export const databases = ['founders_lens_m02_dev', 'founders_lens_m02_test', 'founders_lens_m02_shadow'];
export const roles = ['fl_m02_migrator', 'fl_m02_runtime'];
export const migrationPath = 'apps/api/prisma/migrations/0001_approved_baseline/migration.sql';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const approvedMigrations = [
  ['0001_approved_baseline', '19fcf7f5f144d1ff39a00a489193392e9deaa60617ebe2f42a8ee576e203032b'],
  ['0002_p9_context', 'aa24e097c5ebaaa6bb683f27eac7ad3163e14595623bd3ad51eb427e94a67c46'],
  ['0003_p9_provider_receipt', 'f13342b7740293bae2467669abb63462bf4ac49e40f6ff43c3bba95f63286053'],
  ['0004_m06_selected_context', '88c4a464f0f0f7fb27e028781ee2666334adffaf151f4a927cee535fa56a215e'],
  ['0005_m06_approved_memory', '3cf987d87099a9f31bcb55b55f9766701af19482a7cd7bd4929744619e907b1d']
];
// These exact historical byte variants are valid only in local database history.
const historicalLocalChecksums = new Map([
  ['0002_p9_context', 'e30c7f7003eb74fa715e3457d4ec220f08bc33f9b66287dab2d3979a1c212fff'],
  ['0003_p9_provider_receipt', 'a0a3a093f734c1f55440cd5b5a74f386191bb1a6e5403a78d7248511ecf03058'],
  ['0004_m06_selected_context', '7533b2e2afdabf85653f100fce9abb7cf24d9a81f885dc740cd51fc975770194']
]);
export const localMigrationChecksumMatches = (step, checksum) => checksum === step.checksum ||
  historicalLocalChecksums.get(step.name) === checksum;

export async function settings(readSettingsFile = readFile) {
  const values = parseEnv(await readSettingsFile(path.join(root, '.env.database'), 'utf8'));
  const keys = ['MIGRATION_DATABASE_URL', 'TEST_MIGRATION_DATABASE_URL', 'SHADOW_DATABASE_URL', 'DATABASE_URL', 'TEST_DATABASE_URL'];
  const targets = [databases[0], databases[1], databases[2], databases[0], databases[1]];
  for (const [index, key] of keys.entries()) {
    let url;
    try { url = new URL(values[key]); } catch { throw new Error(`Invalid local configuration: ${key}`); }
    if (url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1' || url.port !== '55432' ||
      url.pathname !== '/' + targets[index] || url.username !== roles[index < 3 ? 0 : 1] ||
      !/^[a-f0-9]{64}$/.test(url.password) || url.search !== '?schema=public' || url.hash) {
      throw new Error(`Rejected local configuration: ${key}`);
    }
  }
  if (new URL(values.MIGRATION_DATABASE_URL).password !== new URL(values.TEST_MIGRATION_DATABASE_URL).password ||
    new URL(values.MIGRATION_DATABASE_URL).password !== new URL(values.SHADOW_DATABASE_URL).password ||
    new URL(values.DATABASE_URL).password !== new URL(values.TEST_DATABASE_URL).password ||
    new URL(values.DATABASE_URL).password === new URL(values.MIGRATION_DATABASE_URL).password) {
    throw new Error('Role credentials must be consistent and separate');
  }
  return values;
}

export function connection(url) {
  const parsed = new URL(url);
  return new pg.Client({ host: parsed.hostname, port: Number(parsed.port), user: parsed.username,
    password: parsed.password, database: parsed.pathname.slice(1), connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000, application_name: 'founders-lens-m02-verifier' });
}

export async function reviewedMigration() {
  const schema = await readFile(path.join(root, 'apps/api/prisma/schema.prisma'), 'utf8');
  const approved = await readFile(path.join(root, 'Docs/lld/01-database/schema/schema.prisma'), 'utf8');
  const guards = await readFile(path.join(root, 'Docs/lld/01-database/constraints/guards.sql'), 'utf8');
  const sql = await readFile(path.join(root, migrationPath), 'utf8');
  // Project the reviewed additions out of the runtime schema for the baseline comparison.
  const baselineDomain = schema.slice(schema.indexOf('enum AccountStatus'))
    .replace('  providerReceipt GenerationProviderReceipt?\n', '')
    .replace('  leaseClaimant        String? @db.VarChar(63)\n', '')
    .replace(`model GenerationProviderReceipt {
  attemptId    String @id @db.Uuid
  attempt      GenerationAttempt @relation(fields: [attemptId], references: [id], onDelete: Cascade)
  leaseEpoch   Int
  responseId   String? @db.VarChar(256)
  inputTokens  Int
  outputTokens Int
  totalTokens  Int
  observedAt   DateTime @default(dbgenerated("clock_timestamp()")) @db.Timestamptz(3)
}

`, '');
  if (baselineDomain !== approved.slice(approved.indexOf('enum AccountStatus')) ||
    !sql.includes(guards) || (sql.match(/^CREATE TABLE /gm) ?? []).length !== 24 ||
    (sql.match(/^CREATE TYPE /gm) ?? []).length !== 24 ||
    /\b(DROP|TRUNCATE|DELETE FROM|ALTER SYSTEM|CREATE ROLE|CREATE DATABASE)\b/i.test(sql.replace(/--[^\r\n]*/g, ''))) {
    throw new Error('Approved schema/guard or additive migration verification failed');
  }
  const directory = path.join(root, 'apps/api/prisma/migrations');
  const names = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory())
    .map(entry => entry.name).sort();
  if (names.length !== approvedMigrations.length || names.some((name, index) => name !== approvedMigrations[index][0])) {
    throw new Error('Unexpected local migration inventory');
  }
  const steps = await Promise.all(approvedMigrations.map(async ([name, checksum]) => {
    const bytes = await readFile(path.join(directory, name, 'migration.sql'));
    if (sha256(bytes) !== checksum) throw new Error('Unreviewed local migration');
    return { name, checksum, publicTables: [...bytes.toString().matchAll(/^CREATE TABLE (?:public\.)?"([^"]+)"/gm)]
      .map(match => match[1]) };
  }));
  return { sql, checksum: steps[0].checksum, steps };
}

async function adminConnection() {
  const env = parseEnv(await readFile(path.join(root, '.env.infrastructure'), 'utf8'));
  if (env.POSTGRES_USER !== 'founders_lens_local' || env.POSTGRES_DB !== 'founders_lens_local' ||
    env.POSTGRES_PORT !== '55432' || !/^[a-f0-9]{64}$/.test(env.POSTGRES_PASSWORD ?? '')) {
    throw new Error('Unexpected infrastructure target');
  }
  return new pg.Client({ host: '127.0.0.1', port: 55432, user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD, database: 'postgres', connectionTimeoutMillis: 5_000 });
}

async function inventory(client) {
  const roleRows = (await client.query('SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit FROM pg_roles WHERE rolname = ANY($1)', [roles])).rows;
  const dbRows = (await client.query('SELECT datname, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = ANY($1)', [databases])).rows;
  return { roles: roleRows, databases: dbRows };
}

async function prismaDeploy(values, url) {
  const env = { ...process.env, ...values, MIGRATION_DATABASE_URL: url, CHECKPOINT_DISABLE: '1' };
  delete env.DEBUG;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--config', 'prisma.config.ts'],
      { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });
  let safe = result.output.replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[redacted database URL]');
  for (const value of Object.values(values)) safe = safe.replaceAll(new URL(value).password, '[redacted]');
  process.stdout.write(safe);
  if (result.code !== 0) throw new DatabaseCliError(`Prisma migration failed (exit ${result.code}).`);
}

// Only this class carries messages safe to print. Driver errors can contain
// SQL, credentials, or details from the server and stay out of diagnostics.
class DatabaseCliError extends Error {}

async function createRoles(admin, values) {
  await admin.query('BEGIN');
  try {
    await admin.query("SET LOCAL password_encryption = 'scram-sha-256'");
    // Roles are database identities. Least privilege gives the migrator
    // ownership and limits the runtime role to the access granted later.
    for (const [index, role] of roles.entries()) {
      const password = new URL(values[index === 0 ? 'MIGRATION_DATABASE_URL' : 'DATABASE_URL']).password;
      await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD '${password}'`);
    }
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function provision(admin, current, values) {
  // Setup is not idempotent: repeating it can collide with objects from a
  // previous attempt. Refuse all collisions before issuing any write.
  if (current.roles.length || current.databases.length) {
    throw new DatabaseCliError('Provisioning refused: a planned role or database already exists. No setup writes were attempted.');
  }
  let completed = 'inventory check';
  let step = 'role creation or commit';
  try {
    await createRoles(admin, values);
    completed = 'role commit';
    // PostgreSQL creates databases outside a transaction block. A failure here
    // can leave roles or databases in place, so record only acknowledged steps.
    for (const database of databases) {
      step = `create database ${database}`;
      await admin.query(`CREATE DATABASE ${database} OWNER fl_m02_migrator`);
      completed = step;
      step = `revoke public access to ${database}`;
      await admin.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
      completed = step;
      if (database !== databases[2]) {
        step = `grant runtime connect to ${database}`;
        await admin.query(`GRANT CONNECT ON DATABASE ${database} TO fl_m02_runtime`);
        completed = step;
      }
    }
  } catch {
    // A lost acknowledgement leaves the failing step uncertain. Inventory is
    // safe to inspect before deciding how to recover. Setup never retries.
    throw new DatabaseCliError(`Provisioning stopped at: ${step}. Last confirmed step: ${completed}. Run the read-only plan and review the inventory before manual recovery.`);
  }
}

async function migrate(current, values, migration) {
  if (current.roles.length !== 2 || current.databases.length !== 3 ||
      current.roles.some(role => role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolreplication || role.rolbypassrls || role.rolinherit) ||
      current.databases.some(db => db.owner !== roles[0])) throw new DatabaseCliError('Unexpected role/database ownership');
  // Inspect both targets before the first deploy. A migration is a recorded
  // schema change, so existing history must match the reviewed checksum.
  for (const key of ['MIGRATION_DATABASE_URL', 'TEST_MIGRATION_DATABASE_URL']) {
    const client = connection(values[key]);
    await client.connect();
    try {
      const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.map(row => row.tablename);
      if (tables.length) {
        if (!tables.includes('_prisma_migrations')) {
          throw new DatabaseCliError('Unrecognized existing database contents');
        }
        const rows = (await client.query('SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY started_at')).rows;
        if (!rows.length || rows.length > migration.steps.length || rows.some((row, index) => {
          const step = migration.steps[index];
          return row.migration_name !== step.name || !localMigrationChecksumMatches(step, row.checksum) ||
            !row.finished_at || row.rolled_back_at;
        })) {
          throw new DatabaseCliError('Unrecognized or failed migration history');
        }
        const expected = new Set(['_prisma_migrations', ...migration.steps.slice(0, rows.length).flatMap(step => step.publicTables)]);
        if (tables.length !== expected.size || tables.some(table => !expected.has(table))) {
          throw new DatabaseCliError('Unrecognized existing database contents');
        }
      }
    } finally { await client.end(); }
  }
  for (const key of ['MIGRATION_DATABASE_URL', 'TEST_MIGRATION_DATABASE_URL']) {
    await prismaDeploy(values, values[key]);
    const client = connection(values[key]);
    await client.connect();
    try { await client.query(await readFile(path.join(root, 'apps/api/prisma/privileges.sql'), 'utf8')); }
    finally { await client.end(); }
  }
}

export async function main(command, { readSettingsFile = readFile, openAdmin = adminConnection, report = console.log } = {}) {
  if (!['plan', 'provision', 'migrate'].includes(command)) throw new DatabaseCliError('Expected plan, provision or migrate');
  let phase = 'local database target validation';
  let admin;
  try {
    const values = await settings(readSettingsFile);
    phase = 'reviewed migration validation';
    const migration = await reviewedMigration();
    phase = 'local infrastructure validation or connection';
    admin = await openAdmin();
    await admin.connect();
    phase = 'read-only inventory';
    const current = await inventory(admin);
    report(JSON.stringify({ command, migrationSHA256: migration.checksum, plannedDatabases: databases,
      plannedRoles: roles, current, runtime: 'CONNECT dev/test; USAGE public; SELECT/INSERT/UPDATE application tables; no DELETE/DDL/purge/migration-table access' }));
    if (command === 'provision') {
      phase = 'provisioning';
      await provision(admin, current, values);
      report('Created only the two named roles and three isolated databases; bootstrap database unchanged.');
    } else if (command === 'migrate') {
      phase = 'migration or restricted grants';
      await migrate(current, values, migration);
      report('Reviewed migrations and restricted grants applied to isolated dev/test only.');
    }
  } catch (error) {
    if (admin) await admin.end().catch(() => {});
    if (error instanceof DatabaseCliError) throw error;
    throw new DatabaseCliError(`Local database operation failed during ${phase}.`);
  }
  try { await admin.end(); }
  catch { throw new DatabaseCliError('The command finished, but closing the local database connection failed.'); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv[2]); }
  catch (error) {
    // Driver errors may contain connection details; never dump raw errors or SQL.
    console.error('Database operation stopped:', error instanceof DatabaseCliError ? error.message : 'verification or local operation failed');
    process.exitCode = 1;
  }
}
