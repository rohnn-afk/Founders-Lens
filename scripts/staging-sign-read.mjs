import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { createSuppressionLedger } from '../apps/api/dist/security/suppression-ledger.js';
import { stagingConnectionTimeout } from '../apps/api/dist/workspace/staging-config.js';

async function issue() {
  const required = name => {
    if (!process.env[name]) throw new Error('Missing operator setting');
    return process.env[name];
  };
  if (required('FL_CONFIRM_STAGING_READ') !== 'approve-staging-read-only') throw new Error('Approval required');
  const privateKey = createPrivateKey(await readFile(required('FL_OPERATOR_PRIVATE_KEY_FILE')));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Invalid operator key');
  const expectedPrimary = required('FL_EXPECTED_PRIMARY_IDENTITY');
  const expectedAuthority = required('FL_EXPECTED_AUTHORITY_IDENTITY');
  const target = /^[1-9][0-9]{0,19}:[1-9][0-9]{0,9}$/;
  if (![expectedPrimary, expectedAuthority].every(identity => target.test(identity)) ||
    expectedPrimary.split(':')[0] === expectedAuthority.split(':')[0]) throw new Error('Invalid target pair');
  const integrity = required('FL_AUTHORITY_INTEGRITY_KEY');
  if (!/^[0-9a-f]{64}$/.test(integrity)) throw new Error('Invalid authority key');
  const output = required('FL_STAGING_DECISION_OUTPUT');
  const connectionTimeoutMillis = stagingConnectionTimeout(process.env);
  const pool = connectionString => new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis,
    statement_timeout: 4000, query_timeout: 4500 });
  const primary = pool(required('FL_OPERATOR_PRIMARY_READ_URL'));
  const authority = pool(required('FL_OPERATOR_AUTHORITY_READ_URL'));
  try {
    const ledger = createSuppressionLedger(authority, {
      epoch: required('FL_AUTHORITY_EPOCH'), challengeNamespace: required('FL_AUTHORITY_NAMESPACE'),
      integrityKey: Buffer.from(integrity, 'hex'), subjectVersions: [1]
    });
    const { rows } = await primary.query(`SELECT system_identifier::text || ':' || d.oid::text AS identity
      FROM pg_catalog.pg_control_system(), pg_catalog.pg_database d WHERE d.datname=current_database()`);
    const snapshot = await ledger.runtimeSnapshot();
    if (rows[0]?.identity !== expectedPrimary || snapshot.authorityIdentity !== expectedAuthority) throw new Error('Target mismatch');
    const issuedAt = Date.now(), recoveryRun = randomUUID();
    const decision = purpose => {
      const bytes = Buffer.from(JSON.stringify({ version: 1, purpose, primaryTarget: expectedPrimary,
        authorityIdentity: expectedAuthority, namespace: snapshot.namespace, epoch: snapshot.epoch, recoveryRun,
        inventoryDigest: snapshot.inventoryDigest, subjectVersions: snapshot.subjectVersions, issuedAt, expiresAt: issuedAt + 300_000 }));
      return { payload: bytes.toString('base64url'), signature: sign(null, bytes, privateKey).toString('base64url') };
    };
    await writeFile(output, JSON.stringify({
      FL_STAGING_IDEAS_DECISION: JSON.stringify(decision('founders-lens:staging-workspace:read-only')),
      FL_STAGING_TRANSCRIPT_DECISION: JSON.stringify(decision('founders-lens:staging-workspace:read-conversations'))
    }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  } finally {
    await Promise.all([primary.end(), authority.end()]);
  }
}

try {
  await issue();
  console.log('Staging read decisions issued.');
} catch {
  console.error('Staging read decision issuance denied.');
  process.exitCode = 1;
}
