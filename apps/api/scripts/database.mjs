import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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

export async function settings() {
  const values = parseEnv(await readFile(path.join(root, '.env.database'), 'utf8'));
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
  if (schema.slice(schema.indexOf('enum AccountStatus')) !== approved.slice(approved.indexOf('enum AccountStatus')) ||
    !sql.includes(guards) || (sql.match(/^CREATE TABLE /gm) ?? []).length !== 24 ||
    (sql.match(/^CREATE TYPE /gm) ?? []).length !== 24 ||
    /\b(DROP|TRUNCATE|DELETE FROM|ALTER SYSTEM|CREATE ROLE|CREATE DATABASE)\b/i.test(sql.replace(/--[^\r\n]*/g, ''))) {
    throw new Error('Approved schema/guard or additive migration verification failed');
  }
  return { sql, checksum: sha256(sql) };
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
  if (result.code !== 0) throw new Error(`Prisma migration failed (exit ${result.code})`);
}

export async function main(command) {
  if (!['plan', 'provision', 'migrate'].includes(command)) throw new Error('Expected plan, provision or migrate');
  const values = await settings();
  const migration = await reviewedMigration();
  const admin = await adminConnection();
  await admin.connect();
  try {
    const current = await inventory(admin);
    console.log(JSON.stringify({ command, migrationSHA256: migration.checksum, plannedDatabases: databases,
      plannedRoles: roles, current, runtime: 'CONNECT dev/test; USAGE public; SELECT/INSERT/UPDATE application tables; no DELETE/DDL/purge/migration-table access' }));
    if (command === 'plan') return;
    if (command === 'provision') {
      if (current.roles.length || current.databases.length) throw new Error('Name collision: provisioning will not overwrite existing resources');
      await admin.query('BEGIN');
      try {
        await admin.query("SET LOCAL password_encryption = 'scram-sha-256'");
        for (const [index, role] of roles.entries()) {
          const password = new URL(values[index === 0 ? 'MIGRATION_DATABASE_URL' : 'DATABASE_URL']).password;
          await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD '${password}'`);
        }
        await admin.query('COMMIT');
      } catch (error) { await admin.query('ROLLBACK'); throw error; }
      for (const database of databases) {
        await admin.query(`CREATE DATABASE ${database} OWNER fl_m02_migrator`);
        await admin.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
        if (database !== databases[2]) await admin.query(`GRANT CONNECT ON DATABASE ${database} TO fl_m02_runtime`);
      }
      console.log('Created only the two named roles and three isolated databases; bootstrap database unchanged.');
      return;
    }
    if (current.roles.length !== 2 || current.databases.length !== 3 ||
      current.roles.some(role => role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolreplication || role.rolbypassrls || role.rolinherit) ||
      current.databases.some(db => db.owner !== roles[0])) throw new Error('Unexpected role/database ownership');
    for (const key of ['MIGRATION_DATABASE_URL', 'TEST_MIGRATION_DATABASE_URL']) {
      const client = connection(values[key]);
      await client.connect();
      try {
        const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.map(row => row.tablename);
        if (tables.length) {
          const expected = [...migration.sql.matchAll(/^CREATE TABLE "([^"]+)"/gm)].map(match => match[1]);
          expected.push('_prisma_migrations');
          if (tables.length !== expected.length || tables.some(table => !expected.includes(table))) {
            throw new Error('Unrecognized existing database contents');
          }
          const rows = (await client.query('SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations"')).rows;
          if (rows.length !== 1 || rows[0].migration_name !== '0001_approved_baseline' || rows[0].checksum !== migration.checksum || !rows[0].finished_at || rows[0].rolled_back_at) {
            throw new Error('Unrecognized or failed migration history');
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
    console.log('Reviewed baseline and restricted grants applied to isolated dev/test only.');
  } finally { await admin.end(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv[2]); }
  catch (error) {
    // Driver errors may contain connection details; never dump raw errors or SQL.
    console.error('Database operation stopped:', error.code ?? (error.message?.startsWith('Prisma migration failed') ? error.message : 'verification or local operation failed'));
    process.exitCode = 1;
  }
}
