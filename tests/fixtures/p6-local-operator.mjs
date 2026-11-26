// Operator-only helpers for the two fixed P6 targets. Express never imports this module.
import assert from 'node:assert/strict';
import { createHash, createHmac, createPrivateKey, createPublicKey, pbkdf2Sync, randomBytes, randomUUID, sign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { createSuppressionLedger } from '../../apps/api/dist/security/suppression-ledger.js';
import { SubjectKeys } from '../../apps/api/dist/security/subject-key.js';
import { p9AcceptanceTarget, p9RecheckTarget, p9OfflineTarget } from './p9-targets.mjs';

/** Verify the isolated role inventory before altering any login. Administrators are trusted. */
async function audit(pool, expected) {
  const { rows } = await pool.query(`SELECT rolname FROM pg_roles WHERE rolcanlogin AND left(rolname,3) <> 'pg_'`);
  assert.ok(rows.every(row => expected.includes(row.rolname)) && rows.some(row => row.rolname === 'postgres'),
    'Unexpected P6 login');
  const { rows: [state] } = await pool.query(`SELECT NOT EXISTS (SELECT FROM pg_auth_members m
    JOIN pg_roles member ON member.oid = m.member WHERE left(member.rolname,3) <> 'pg_') AS isolated,
    NOT EXISTS (SELECT FROM pg_roles WHERE left(rolname,3) <> 'pg_' AND rolname <> 'postgres'
      AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)) AS restricted,
    NOT EXISTS (SELECT FROM pg_prepared_xacts) AS clean,
    NOT EXISTS (SELECT FROM pg_stat_activity WHERE usename='postgres' AND pid <> pg_backend_pid()
      AND state <> 'idle') AS sole_operator`);
  assert.ok(state.isolated && state.restricted && state.clean && state.sole_operator, 'Unexpected P6 role or prepared transaction');
}

/** Recheck effective grants, including implicit PUBLIC grants, before admitting a P6 write. */
export async function verifyP6ProvisioningGrants(primary) {
  const { rows } = await primary.query(`SELECT c.relname, a.attname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped
      AND has_column_privilege('fl_p6_provision', c.oid, a.attnum, 'INSERT')`);
  assert.ok(rows.every(row => row.relname === 'UserAccount') && rows.map(row => row.attname).sort().join(',') ===
    'clerkInstanceId,clerkSubject,id,subjectKey,subjectKeyVersion,updatedAt', 'Unexpected provisioning insert grants');
  const { rows: [state] } = await primary.query(`SELECT
    has_schema_privilege('fl_p6_provision', 'public', 'CREATE') AS ddl,
    has_database_privilege('fl_p6_provision', current_database(), 'CREATE,TEMPORARY') AS database_write,
    EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p') AND
      (has_any_column_privilege('fl_p6_provision',c.oid,'UPDATE') OR
      has_table_privilege('fl_p6_provision',c.oid,'DELETE,TRUNCATE,TRIGGER'))) AS table_write`);
  assert.ok(!state.ddl && !state.database_write && !state.table_write, 'Unexpected provisioning write privileges');
}

async function drain(pool, role) {
  await pool.query('SELECT pg_terminate_backend(pid, 3000) FROM pg_stat_activity WHERE usename = $1', [role]);
  const { rows: [state] } = await pool.query('SELECT count(*)::int AS sessions FROM pg_stat_activity WHERE usename = $1', [role]);
  assert.ok(state.sessions === 0, 'P6 writer did not drain');
}

// Send only the SCRAM verifier to PostgreSQL, never the login password in SQL.
function scramVerifier(password) {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
  const stored = createHash('sha256').update(createHmac('sha256', salted).update('Client Key').digest()).digest('base64');
  const server = createHmac('sha256', salted).update('Server Key').digest('base64');
  return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}`;
}

/** Admit one restricted backend. On uncertainty, leave ordinary writers disabled for inspection. */
export async function withP6Provisioning(context, bind) {
  const { primary, authority } = context;
  await context.verify();
  const runtimeRoles = ['fl_p6_workspace', ...(context.isolated
    ? ['fl_p8_conversations', 'fl_p9_submit', 'fl_p9_dispatch', 'fl_p9_worker', 'fl_p9_context_verifier'] : []),
    ...(context.offline ? ['fl_p7_idea_create', 'fl_idea_edit'] : [])];
  await audit(primary, ['postgres', 'fl_p6_provision', ...runtimeRoles]);
  await audit(authority, ['postgres', 'ledger_reader', 'ledger_writer']);
  const login = async (pool, role) => (await pool.query('SELECT rolcanlogin FROM pg_roles WHERE rolname = $1', [role])).rows[0]?.rolcanlogin;
  const workspaceLogin = await login(primary, 'fl_p6_workspace');
  const writerLogin = await login(authority, 'ledger_writer');
  assert.ok(workspaceLogin && writerLogin, 'Interrupted maintenance requires operator inspection');
  const enabled = [];
  for (const role of runtimeRoles) if (await login(primary, role)) enabled.push(role);
  let clean = false;
  const exclusion = await authority.connect();
  try {
    await authority.query('ALTER ROLE ledger_writer NOLOGIN');
    for (const role of runtimeRoles) await primary.query('ALTER ROLE ' + role + ' NOLOGIN');
    await primary.query('ALTER ROLE fl_p6_provision NOLOGIN PASSWORD NULL');
    await drain(authority, 'ledger_writer');
    for (const role of runtimeRoles) await drain(primary, role);
    await drain(primary, 'fl_p6_provision');
    // SHARE locks block DML while ordinary clearance reads remain available.
    await exclusion.query('BEGIN; LOCK TABLE authority.intent, authority.coverage, authority.inventory_count, authority.recovery_progress IN SHARE MODE');
    await context.verify();
    const password = randomBytes(32).toString('hex');
    const verifier = scramVerifier(password);
    const expiry = new Date(Date.now() + 30_000).toISOString();
    // Only the SCRAM verifier reaches SQL. Close new authentication as soon as
    // the pool has its sole backend, before Prisma performs any write.
    await primary.query(`ALTER ROLE fl_p6_provision LOGIN CONNECTION LIMIT 1 PASSWORD '${verifier}' VALID UNTIL '${expiry}'`);
    const pool = context.provision(password);
    await pool.query('SELECT 1');
    await primary.query('ALTER ROLE fl_p6_provision NOLOGIN PASSWORD NULL');
    const { rows: [sessions] } = await primary.query(`SELECT count(*)::int AS total FROM pg_stat_activity
      WHERE usename = 'fl_p6_provision' AND datname=current_database()`);
    assert.ok(sessions.total === 1 && !await login(primary, 'fl_p6_provision') &&
      !await login(authority, 'ledger_writer'), 'Writer exclusion unavailable');
    for (const role of runtimeRoles) assert.equal(await login(primary, role), false, 'Runtime login still enabled');
    await bind(pool);
    await exclusion.query('SELECT 1');
    await context.verify();
    await drain(primary, 'fl_p6_provision');
    clean = true;
  } finally {
    try {
      await primary.query('ALTER ROLE fl_p6_provision NOLOGIN PASSWORD NULL');
      await drain(primary, 'fl_p6_provision');
    } finally {
      try { await exclusion.query('ROLLBACK'); } finally { exclusion.release(); }
    }
    if (clean) {
      for (const role of enabled) await primary.query('ALTER ROLE ' + role + ' LOGIN');
      await authority.query('ALTER ROLE ledger_writer LOGIN');
    }
  }
}

/** Seed only the verified P9 binding through an ephemeral, insert-only role. */
export async function seedP9Conversation(context, accountId, title = 'Lantern Locker') {
  assert.ok(context.isolated, 'Isolated P9 target required');
  const client = await context.primary.connect();
  const ideaId = randomUUID(), conversationId = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE ROLE fl_p9_scope_seed NOLOGIN NOINHERIT;
      GRANT USAGE ON SCHEMA public TO fl_p9_scope_seed;
      GRANT INSERT (id,"ownerId",title,"updatedAt") ON public."Idea" TO fl_p9_scope_seed;
      GRANT INSERT (id,"ideaId","updatedAt","proactiveResearch") ON public."Conversation" TO fl_p9_scope_seed;
      SET LOCAL ROLE fl_p9_scope_seed`);
    await client.query('INSERT INTO public."Idea" (id,"ownerId",title,"updatedAt") VALUES ($1,$2,$3,clock_timestamp())',
      [ideaId, accountId, title]);
    await client.query('INSERT INTO public."Conversation" (id,"ideaId","updatedAt","proactiveResearch") VALUES ($1,$2,clock_timestamp(),false)',
      [conversationId, ideaId]);
    await client.query(`RESET ROLE;
      REVOKE USAGE ON SCHEMA public FROM fl_p9_scope_seed;
      REVOKE INSERT (id,"ownerId",title,"updatedAt") ON public."Idea" FROM fl_p9_scope_seed;
      REVOKE INSERT (id,"ideaId","updatedAt","proactiveResearch") ON public."Conversation" FROM fl_p9_scope_seed;
      DROP ROLE fl_p9_scope_seed;
      COMMIT`);
    return { ideaId, conversationId };
  } finally {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
}

/** Install only the local idea writer. An interrupted setup requires operator inspection. */
export async function prepareP7IdeaWriter(context, confirmation) {
  assert.ok(confirmation === 'prepare-p7-idea-writer', 'Explicit operator approval required');
  await prepareWorkspaceRole(context, 'fl_p7_idea_create', './p7-idea-create-grants.sql',
    '.env.p7.writer.local', 'FL_P7_IDEA_CREATE_PASSWORD');
}

export async function prepareIdeaEditor(context, confirmation) {
  assert.ok(!context.isolated && confirmation === 'prepare-local-idea-editor', 'Explicit local P6 approval required');
  await prepareWorkspaceRole(context, 'fl_idea_edit', './idea-edit-grants.sql',
    '.env.idea-editor.local', 'FL_IDEA_EDIT_PASSWORD');
}

/** Provision only the P8 role on the verified local primary, without inserting application data. */
export async function prepareP8Conversations(context, confirmation) {
  assert.ok(confirmation === 'prepare-p8-conversations', 'Explicit operator approval required');
  await prepareWorkspaceRole(context, 'fl_p8_conversations', './p8-conversation-grants.sql',
    '.env.p8.role.local', 'FL_P8_CONVERSATIONS_PASSWORD');
}

async function prepareWorkspaceRole(context, role, grantFile, environmentFile, passwordName) {
  await context.verify();
  const { rows: [state] } = await context.primary.query(`SELECT
    (SELECT count(*)::int FROM "UserAccount" WHERE status='ACTIVE') AS active,
    NOT EXISTS (SELECT FROM pg_roles WHERE rolname=$1) AS absent,
    (SELECT NOT rolcanlogin FROM pg_roles WHERE rolname='fl_p6_provision') AS provision_closed`, [role]);
  assert.ok(state.active === 1 && state.absent && state.provision_closed, 'Local role requires a bound workspace and fresh setup');
  const password = randomBytes(32).toString('hex');
  const grants = await readFile(new URL(grantFile, import.meta.url), 'utf8');
  await writeFile(environmentFile, `${passwordName}=${password}\n`, { flag: 'wx', mode: 0o600 });
  const client = await context.primary.connect();
  try {
    await client.query('BEGIN');
    // The role identifier comes only from a fixed operator entry point.
    await client.query(`CREATE ROLE ${role} LOGIN NOINHERIT PASSWORD '${scramVerifier(password)}'`);
    await client.query(grants);
    await client.query('COMMIT');
  } finally {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
}

export async function p6Operator(t, { isolated = false, cedar = false, recheck = false, offline = false } = {}) {
  assert.ok(!cedar || isolated, 'Isolated Cedar operator target required');
  assert.ok(!recheck || cedar, 'Cedar profile required for recheck target');
  assert.ok(!offline || isolated && !cedar, 'Dedicated offline operator target required');
  const target = offline ? p9OfflineTarget : recheck ? p9RecheckTarget : p9AcceptanceTarget;
  const envPrefix = offline ? '.env.p9-offline-primary.' : recheck ? '.env.p9-cedar-recheck-primary.' :
    cedar ? '.env.p9-cedar-primary.' : isolated ? '.env.p9-primary.' : '.env.p6.';
  const local = parseEnv(await readFile(envPrefix + 'runtime.local', 'utf8'));
  const operator = parseEnv(await readFile(envPrefix + 'operator.local', 'utf8'));
  const { record, integrity } = JSON.parse(Buffer.from(local.FL_P6_GENESIS, 'base64url').toString('utf8'));
  assert.ok(integrity === createHmac('sha256', Buffer.from(operator.FL_P6_GENESIS_KEY, 'hex'))
    .update(JSON.stringify(['p6-fresh-genesis-v1', record])).digest('hex'), 'Genesis could not be authenticated');
  assert.ok(record.version === 1 && record.subjectVersions.length === 1 && record.subjectVersions[0] === 1 &&
    record.primary.cluster !== record.authority.cluster, 'Unexpected genesis policy');
  const pool = (port, database, user, password, max = 1) => {
    assert.ok(/^[a-f0-9]{64}$/.test(password ?? ''), 'Required P6 credential unavailable');
    const result = new pg.Pool({ host: '127.0.0.1', port, database, user, password, max,
      connectionTimeoutMillis: 1500, statement_timeout: 4000, query_timeout: 5000 });
    result.on('error', () => {});
    t.after(() => result.end());
    return result;
  };
  const primaryPort = cedar || offline ? target.primaryPort : isolated ? 55435 : 55437;
  const authorityPort = cedar || offline ? target.authorityPort : isolated ? 55438 : 55436;
  const primaryDatabase = cedar || offline ? target.database : isolated ? 'founders_lens_p9_local' : 'founders_lens_p6_local';
  const primary = pool(primaryPort, primaryDatabase, 'postgres', operator.FL_P6_PRIMARY_ADMIN_PASSWORD);
  const authority = pool(authorityPort, 'suppression_proof', 'postgres', operator.FL_SUPPRESSION_ADMIN_PASSWORD, 2);
  const reader = pool(authorityPort, 'suppression_proof', 'ledger_reader', local.FL_SUPPRESSION_READER_PASSWORD);
  const subjectKeys = new SubjectKeys(1, new Map([[1, Buffer.from(local.FL_P6_SUBJECT_KEY_V1, 'hex')]]));
  assert.ok(local.FL_P6_SUBJECT_KEY_V1 === operator.FL_P6_SUBJECT_KEY_V1, 'Retained key mismatch');
  const ledger = createSuppressionLedger(reader, { epoch: record.epoch, challengeNamespace: record.namespace,
    subjectVersions: [1], integrityKey: Buffer.from(local.FL_P6_INTEGRITY_KEY, 'hex') });
  async function verify() {
    const target = async client => (await client.query(`SELECT system_identifier::text || ':' || oid::text AS target
      FROM pg_catalog.pg_control_system(), pg_catalog.pg_database WHERE datname=current_database()`)).rows[0].target;
    const snapshot = await ledger.runtimeSnapshot();
    const primaryTarget = await target(primary);
    assert.ok(primaryTarget === record.primary.cluster + ':' + record.primary.oid &&
      await target(authority) === record.authority.cluster + ':' + record.authority.oid &&
      snapshot.authorityIdentity === record.authority.cluster + ':' + record.authority.oid &&
      snapshot.epoch === record.epoch && snapshot.namespace === record.namespace &&
      snapshot.subjectVersions.length === 1 && snapshot.subjectVersions[0] === 1 &&
      snapshot.inventoryDigest === record.inventoryDigest, 'P6 state differs from authenticated genesis');
    return { primaryTarget, snapshot };
  }
  await verify();
  return { primary, authority, ledger, subjectKeys, verify, isolated, cedar, recheck, offline,
    provision: password => pool(primaryPort, primaryDatabase, 'fl_p6_provision', password) };
}

/** Issue a five-minute decision only after the operator explicitly invokes signing. */
export async function signP6Clearance(context, privateKeyPath, publicKeyPath, confirmation, createIdea = false) {
  assert.ok(confirmation === (createIdea ? 'approve-p7-create-idea' : 'approve-p6-genesis-read-only'), 'Explicit operator approval required');
  const purpose = createIdea ? 'create-idea' : 'read-only';
  const { pinned, envelope } = await signWorkspaceDecision(context, privateKeyPath, publicKeyPath, purpose);
  if (createIdea) return { FL_P7_CREATE_IDEA_DECISION: envelope };
  return { FL_P6_RECOVERY_DECISION: envelope, FL_P6_OPERATOR_PUBLIC_KEY: pinned.toString('base64'),
    FL_P6_CURSOR_KEY: randomBytes(32).toString('hex') };
}

/** Issue three independently signed, five-minute local conversation permissions. */
export async function signP8Clearances(context, privateKeyPath, publicKeyPath, confirmation) {
  assert.ok(confirmation === 'approve-p8-conversations', 'Explicit operator approval required');
  const decisions = await Promise.all(['read-conversations', 'create-conversation', 'save-user-message']
    .map(purpose => signWorkspaceDecision(context, privateKeyPath, publicKeyPath, purpose)));
  return { FL_P8_READ_DECISION: decisions[0].envelope, FL_P8_CREATE_DECISION: decisions[1].envelope,
    FL_P8_SAVE_DECISION: decisions[2].envelope };
}

export async function signIdeaEditClearance(context, privateKeyPath, publicKeyPath, confirmation) {
  assert.ok(confirmation === 'approve-local-idea-edit', 'Explicit operator approval required');
  const { envelope } = await signWorkspaceDecision(context, privateKeyPath, publicKeyPath, 'edit-idea');
  return { FL_IDEA_EDIT_DECISION: envelope };
}

async function signWorkspaceDecision(context, privateKeyPath, publicKeyPath, purpose) {
  const { pinned, envelopes } = await signDecisions(context, privateKeyPath, publicKeyPath,
    ['founders-lens:local-workspace:' + purpose]);
  return { pinned, envelope: envelopes[0] };
}

/** Bind generation permissions and the supporting workspace reads to one verified recovery run. */
export async function signP9Clearances(context, privateKeyPath, publicKeyPath, confirmation) {
  assert.ok(context.isolated && confirmation === 'approve-p9-isolated-runtime', 'Isolated P9 approval required');
  const purposes = [
    ['FL_P9_SUBMIT_DECISION', 'founders-lens:local-generation:submit'],
    ['FL_P9_STATUS_DECISION', 'founders-lens:local-generation:status'],
    ['FL_P9_DISPATCH_DECISION', 'founders-lens:local-generation:dispatch'],
    ['FL_P9_EXECUTE_DECISION', 'founders-lens:local-generation:execute'],
    ['FL_P6_RECOVERY_DECISION', 'founders-lens:local-workspace:read-only'],
    ['FL_P8_READ_DECISION', 'founders-lens:local-workspace:read-conversations']
  ];
  const { pinned, envelopes } = await signDecisions(context, privateKeyPath, publicKeyPath,
    purposes.map(([, purpose]) => purpose));
  return { FL_P6_OPERATOR_PUBLIC_KEY: pinned.toString('base64'),
    ...Object.fromEntries(purposes.map(([name], index) => [name, envelopes[index]])) };
}

async function signDecisions(context, privateKeyPath, publicKeyPath, purposes) {
  const privateKey = createPrivateKey(await readFile(privateKeyPath));
  const publicKey = createPublicKey(await readFile(publicKeyPath));
  const pinned = publicKey.export({ type: 'spki', format: 'der' });
  assert.ok(privateKey.asymmetricKeyType === 'ed25519' && pinned.equals(createPublicKey(privateKey)
    .export({ type: 'spki', format: 'der' })), 'Operator key does not match the pinned public key');
  const { primaryTarget, snapshot } = await context.verify();
  const issuedAt = Date.now();
  const recoveryRun = randomUUID();
  const envelopes = purposes.map(purpose => {
    const bytes = Buffer.from(JSON.stringify({ version: 1, purpose,
      primaryTarget, authorityIdentity: snapshot.authorityIdentity, namespace: snapshot.namespace, epoch: snapshot.epoch,
      recoveryRun, inventoryDigest: snapshot.inventoryDigest, subjectVersions: snapshot.subjectVersions,
      issuedAt, expiresAt: issuedAt + 300_000 }));
    return JSON.stringify({ payload: bytes.toString('base64url'), signature: sign(null, bytes, privateKey).toString('base64url') });
  });
  return { pinned, envelopes };
}
