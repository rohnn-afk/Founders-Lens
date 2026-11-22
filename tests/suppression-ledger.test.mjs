// Opt-in proof using two new Compose-owned PostgreSQL instances and a persistent authority volume.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import test from 'node:test';
import { Pool } from 'pg';
import { createSuppressionLedger } from '../apps/api/dist/security/suppression-ledger.js';
import { requireClearance, suppressionScopeKey } from '../apps/api/dist/security/suppression-authority.js';

const deny = error => error?.code === 'DEPENDENCY_UNAVAILABLE';
const password = () => randomBytes(32).toString('hex');
const fingerprint = () => randomBytes(32).toString('hex');

test('independent PostgreSQL suppression ledger lifecycle', {
  skip: !process.argv.includes('--suppression-live'), timeout: 240_000
}, async t => {
  const listeners = Array.from({ length: 2 }, () => createServer().listen(0, '127.0.0.1'));
  await Promise.all(listeners.map(server => once(server, 'listening')));
  const ports = listeners.map(server => server.address().port);
  await Promise.all(listeners.map(server => new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()))));
  const project = 'fl-suppression-' + randomUUID();
  const [adminPassword, readerPassword, writerPassword, primaryPassword] = Array.from({ length: 4 }, password);
  const env = { ...process.env, FL_SUPPRESSION_PORT: String(ports[0]), FL_SUPPRESSION_PRIMARY_PORT: String(ports[1]),
    FL_SUPPRESSION_ADMIN_PASSWORD: adminPassword, FL_SUPPRESSION_READER_PASSWORD: readerPassword,
    FL_SUPPRESSION_WRITER_PASSWORD: writerPassword, FL_SUPPRESSION_PRIMARY_PASSWORD: primaryPassword };
  const compose = (...args) => {
    const result = spawnSync('docker', ['compose', '--project-name', project, '-f',
      'tests/fixtures/suppression-ledger.compose.yaml', '--profile', 'rollback', ...args],
    { env, encoding: 'utf8', timeout: 70_000, windowsHide: true });
    // Do not echo Docker output or inspect environments containing credentials.
    assert.equal(result.status, 0, 'Isolated Compose operation failed: ' + args[0]);
    return result.stdout.trim();
  };
  const pools = [];
  const connect = (user, pass, primary = false) => {
    const pool = new Pool({ host: '127.0.0.1', port: ports[Number(primary)], user, password: pass,
      database: primary ? 'primary_proof' : 'suppression_proof',
      connectionTimeoutMillis: 800, statement_timeout: 1000, query_timeout: 1500 });
    pool.on('error', () => {}); // Restart intentionally drops idle connections.
    pools.push(pool);
    return pool;
  };
  t.after(async () => {
    await Promise.all(pools.map(pool => pool.end()));
    // The project name is minted for this invocation. Compose scopes removal to it.
    compose('down', '--volumes');
    assert.equal(compose('ps', '-aq'), '');
  });
  compose('up', '-d', '--wait', '--wait-timeout', '40');
  const admin = connect('postgres', adminPassword);
  const reader = connect('ledger_reader', readerPassword);
  const writer = connect('ledger_writer', writerPassword);
  const primary = connect('postgres', primaryPassword, true);
  const epoch = randomUUID();
  const integrityKey = randomBytes(32);
  const subjectVersions = [1, 2];
  const trusted = { epoch, integrityKey, subjectVersions };
  const lookup = createSuppressionLedger(reader, trusted);
  const admission = createSuppressionLedger(writer, trusted);
  const account = { kind: 'ACCOUNT', instanceId: 'ins_synthetic', subjectKeyVersion: 1,
    subjectKey: fingerprint(), incarnation: 'ALL' };
  const idea = { kind: 'IDEA', instanceId: account.instanceId, accountId: randomUUID(), ideaId: randomUUID() };
  const intent = scope => ({ scope, operationId: randomUUID(), fingerprint: fingerprint(), policyVersion: 'proof_v1' });
  const accountIntent = intent(account);
  const ideaIntent = intent(idea);

  await t.test('bootstrap starts closed and only the operator can establish coverage', async () => {
    // A valid connection and an empty inventory cannot prove absence on their own.
    await assert.rejects(requireClearance(lookup.authority, account), deny);
    const rotated = { ...account, subjectKeyVersion: 2, subjectKey: fingerprint() };
    await assert.rejects((async () => {
      await requireClearance(lookup.authority, rotated);
      await requireClearance(lookup.authority, account);
    })(), deny);
    const omittedOldVersion = createSuppressionLedger(reader, { ...trusted, subjectVersions: [2] });
    await assert.rejects(requireClearance(omittedOldVersion.authority, rotated), deny);
    await assert.rejects(writer.query('DELETE FROM authority.coverage'), { code: '42501' });
    await assert.rejects(reader.query('INSERT INTO authority.intent DEFAULT VALUES'), { code: '42501' });
    const integrity = createHmac('sha256', integrityKey)
      .update(JSON.stringify(['suppression-coverage-v1', epoch, subjectVersions])).digest('hex');
    await admin.query('INSERT INTO authority.coverage VALUES(true,$1,$2,$3)', [epoch, integrity, subjectVersions]);
    await requireClearance(lookup.authority, account);
    await requireClearance(lookup.authority, idea);
    await assert.rejects(requireClearance(lookup.authority, { ...account, subjectKeyVersion: 3 }), deny);
    const restored = createSuppressionLedger(reader, { ...trusted, epoch: randomUUID() });
    await assert.rejects(requireClearance(restored.authority, account), deny);
  });

  await t.test('concurrent account retries converge and conflicting scope or fingerprint fails', async () => {
    // PostgreSQL chooses the winner. Every matching retry must return that ID.
    const retry = { ...accountIntent, operationId: randomUUID() };
    const results = await Promise.all([admission.admit(accountIntent), admission.admit(retry)]);
    assert.equal(results[0], results[1]);
    assert.ok([accountIntent.operationId, retry.operationId].includes(results[0]));
    const conflicting = { ...accountIntent, fingerprint: fingerprint() };
    const competition = await Promise.allSettled([admission.admit(retry), admission.admit(conflicting)]);
    assert.equal(competition[0].status, 'fulfilled');
    assert.equal(competition[1].status, 'rejected');
    await assert.rejects(admission.admit({ ...accountIntent, operationId: results[0], scope: idea }));
    await assert.rejects(requireClearance(lookup.authority, account), deny);
    await requireClearance(lookup.authority, idea);
    await assert.rejects(writer.query('UPDATE authority.intent SET fingerprint=fingerprint'), { code: '42501' });
  });

  await t.test('lost acknowledgement and primary rollback leave the independent intent durable', async () => {
    // Inject response loss after the real authority commit while the primary transaction is open.
    const tx = await primary.connect();
    try {
      await tx.query('BEGIN');
      await tx.query('CREATE TABLE rollback_marker(id uuid)');
      await tx.query('INSERT INTO rollback_marker VALUES($1)', [ideaIntent.operationId]);
      await assert.rejects((async () => {
        await admission.admit(ideaIntent);
        throw new Error('Injected lost acknowledgement after committed insert');
      })(), /Injected lost acknowledgement/);
      await tx.query('ROLLBACK');
    } finally { tx.release(); }
    assert.equal((await primary.query("SELECT to_regclass('public.rollback_marker') AS marker")).rows[0].marker, null);
    assert.equal(await lookup.recover(ideaIntent), ideaIntent.operationId);
    await assert.rejects(requireClearance(lookup.authority, idea), deny);
    await requireClearance(lookup.authority, { ...idea, ideaId: randomUUID() });
  });

  await t.test('stopped authority denies and restart retains inventory and suppression', async () => {
    // An outage must deny even a previously clear scope; restart reuses the named volume.
    compose('stop', 'authority');
    await assert.rejects(requireClearance(lookup.authority, { ...idea, ideaId: randomUUID() }), deny);
    compose('up', '-d', '--wait', '--wait-timeout', '40', 'authority');
    assert.deepEqual(new Set((await lookup.inventory()).map(row => row.scope_key)),
      new Set([suppressionScopeKey(account), suppressionScopeKey(idea)]));
    await assert.rejects(requireClearance(lookup.authority, account), deny);
    await assert.rejects(requireClearance(lookup.authority, idea), deny);
  });

  await t.test('held table lock, corrupt intent and removed coverage deny clearance', async () => {
    // Corrupt or truncated inventories must never turn suppression into apparent absence.
    const tx = await admin.connect();
    try {
      await tx.query('BEGIN');
      await tx.query('LOCK TABLE authority.intent IN ACCESS EXCLUSIVE MODE');
      await assert.rejects(requireClearance(lookup.authority, idea), deny);
      await tx.query('ROLLBACK');
    } finally { tx.release(); }
    await admin.query('UPDATE authority.intent SET integrity=$1 WHERE scope_key=$2', ['0'.repeat(64), suppressionScopeKey(idea)]);
    await assert.rejects(lookup.inventory(), /integrity failure/);
    assert.equal(await lookup.authority.lookup(idea, { nonce: randomUUID(), requestedAt: Date.now() }), null);
    await admin.query('DELETE FROM authority.intent WHERE scope_key=$1', [suppressionScopeKey(idea)]);
    await assert.rejects(lookup.inventory(), /inventory incomplete/);
    await assert.rejects(requireClearance(lookup.authority, idea), deny);
    await admin.query('DELETE FROM authority.coverage');
    await assert.rejects(requireClearance(lookup.authority, { ...idea, ideaId: randomUUID() }), deny);
  });
});
