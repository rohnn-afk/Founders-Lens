import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import test from 'node:test';
import { stagingDecisions } from '../apps/api/dist/workspace/staging-decisions.js';
import { publishStagingPair } from '../scripts/renew-staging-decisions.mjs';
import { directStagingPool } from '../scripts/staging-sign-read.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const primaryTarget = '123:4';
const snapshot = { authorityIdentity: '456:7', namespace: 'hmac-sha256-v1:' + 'a'.repeat(64),
  epoch: randomUUID(), inventoryDigest: 'b'.repeat(64), subjectVersions: [1] };
const keys = ['FL_STAGING_IDEAS_DECISION', 'FL_STAGING_TRANSCRIPT_DECISION'];
function pair(issuedAt = Date.now(), recoveryRun = randomUUID()) {
  return Object.fromEntries(keys.map((key, index) => {
    const payload = Buffer.from(JSON.stringify({ version: 1,
      purpose: 'founders-lens:staging-workspace:' + ['read-only', 'read-conversations'][index],
      primaryTarget, ...snapshot, recoveryRun, // Canonical order is restored below.
      issuedAt, expiresAt: issuedAt + 300_000 }, [
      'version', 'purpose', 'primaryTarget', 'authorityIdentity', 'namespace', 'epoch',
      'recoveryRun', 'inventoryDigest', 'subjectVersions', 'issuedAt', 'expiresAt'
    ]));
    return [key, JSON.stringify({ payload: payload.toString('base64url'),
      signature: sign(null, payload, privateKey).toString('base64url') })];
  }));
}

test('one fresh pair is read on every check, including after restart, and expired or revoked state fails closed', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 2_000_000 });
  let stored, authority = snapshot, loadCount = 0, target = primaryTarget, unavailable = false;
  const pool = { options: { connectionTimeoutMillis: 4000 }, query: async () => ({ rows: [{ identity: target }] }) };
  const boot = () => stagingDecisions(async () => {
    loadCount++;
    if (unavailable) throw new Error('mailbox offline');
    return stored;
  }, { retainedSubjectVersions: [1], hostedStaging: true, operatorPublicKey: publicKey,
    authority: { runtimeSnapshot: async () => authority } }, pool, pool);
  const verify = boot();
  await assert.rejects(verify);
  stored = pair();
  assert.equal(await verify(), 2_300_000);
  t.mock.timers.tick(60_000);
  stored = pair();
  assert.equal(await boot()(), 2_360_000);
  assert.equal(loadCount, 3);
  unavailable = true;
  await assert.rejects(verify);
  unavailable = false;
  authority = { ...snapshot, inventoryDigest: 'c'.repeat(64) };
  await assert.rejects(verify);
  authority = snapshot;
  target = '123:5';
  await assert.rejects(verify);
  target = primaryTarget;
  await assert.doesNotReject(verify);
  t.mock.timers.tick(300_000);
  await assert.rejects(verify);
  stored = pair();
  stored[keys[1]] = pair()[keys[1]];
  await assert.rejects(verify);
  stored[keys[1]] = '{}';
  await assert.rejects(verify);
});

test('publication uses one monotonic, parameterized update after verifying authority identity', async () => {
  const issuedAt = Date.now();
  const next = { issuedAt, pair: pair(issuedAt) };
  const calls = [];
  const client = { query: async (sql, args) => {
    calls.push({ sql, args });
    return args ? { rowCount: 1 } : { rows: [{ identity: snapshot.authorityIdentity }] };
  } };
  await publishStagingPair(client, snapshot.authorityIdentity, next);
  assert.equal(calls.length, 2);
  assert.match(calls[1].sql, /issued_at < \$1/);
  assert.deepEqual(calls[1].args, [issuedAt, JSON.stringify(next.pair)]);
  await assert.rejects(publishStagingPair(client, '456:9', next), /Unexpected renewal database/);
  assert.equal(calls.length, 3);
  await assert.rejects(publishStagingPair(client, snapshot.authorityIdentity,
    { ...next, issuedAt: issuedAt - 61_000 }), /stale/);
  assert.equal(calls.length, 3);
});

test('a database stall cannot publish evidence that went stale during the identity query', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 2_000_000 });
  const issuedAt = Date.now();
  let queries = 0;
  const client = { query: async () => {
    queries++;
    t.mock.timers.tick(60_000);
    return { rows: [{ identity: snapshot.authorityIdentity }] };
  } };
  await assert.rejects(publishStagingPair(client, snapshot.authorityIdentity, { issuedAt, pair: pair(issuedAt) }), /stale/);
  assert.equal(queries, 1);
});

test('renewal survives multiple lifetimes and a restart while rejecting skew, replay and invalid evidence', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 2_000_000 });
  let stored = pair(), current = snapshot;
  const first = stored;
  const primary = { options: { connectionTimeoutMillis: 4000 }, query: async () => ({ rows: [{ identity: primaryTarget }] }) };
  const boot = () => stagingDecisions(async () => stored, {
    retainedSubjectVersions: [1], hostedStaging: true, operatorPublicKey: publicKey,
    authority: { runtimeSnapshot: async () => current }
  }, primary, primary);
  let ready = boot();
  for (let minute = 1; minute <= 16; minute++) {
    t.mock.timers.tick(60_000);
    await assert.doesNotReject(ready);
    stored = pair();
    if (minute === 8) ready = boot();
    assert.equal(await ready(), Date.now() + 300_000);
  }
  stored = first;
  await assert.rejects(ready);
  stored = pair(Date.now() + 1_000);
  await assert.rejects(ready);
  stored = pair();
  current = { ...snapshot, subjectVersions: [1, 2] };
  await assert.rejects(ready);
  current = snapshot;
  const envelope = JSON.parse(stored[keys[0]]);
  envelope.signature = (envelope.signature[0] === 'A' ? 'B' : 'A') + envelope.signature.slice(1);
  stored[keys[0]] = JSON.stringify(envelope);
  await assert.rejects(ready);
  stored = pair();
  await assert.doesNotReject(ready);
});

test('signer rejects pooled, non-TLS and wrong-role URLs before connecting', () => {
  for (const [host, query, role] of [
    ['ep-test-pooler', '?sslmode=verify-full', 'ledger_reader'],
    ['ep-test', '?sslmode=require', 'ledger_reader'],
    ['ep-test', '?sslmode=verify-full', 'owner']]) {
    assert.throws(() => directStagingPool(
      `postgresql://${role}:fixture@${host}.us-west-2.aws.neon.tech/neondb${query}`, 4000, 'ledger_reader'));
  }
});

test('all signer pools handle unexpected idle connection loss', async () => {
  for (const role of ['fl_p6_workspace', 'ledger_reader', 'staging_decision_writer']) {
    const pool = directStagingPool(
      `postgresql://${role}:fixture@ep-test.us-west-2.aws.neon.tech/neondb?sslmode=verify-full`, 4000, role);
    try {
      assert.equal(pool.listenerCount('error'), 1);
    } finally {
      await pool.end();
    }
  }
});
