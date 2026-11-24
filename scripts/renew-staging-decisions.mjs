import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { directStagingPool, issueStagingPair } from './staging-sign-read.mjs';
import { stagingConnectionTimeout } from '../apps/api/dist/workspace/staging-config.js';

export async function publishStagingPair(client, expectedAuthority, { issuedAt, pair }) {
  if (issuedAt > Date.now() || issuedAt + 60_000 <= Date.now()) throw new Error('Renewal evidence is stale');
  const { rows } = await client.query(`
    SELECT system_identifier::text || ':' || d.oid::text AS identity
    FROM pg_catalog.pg_control_system(), pg_catalog.pg_database d WHERE d.datname=current_database()`);
  if (rows[0]?.identity !== expectedAuthority) throw new Error('Unexpected renewal database');
  const update = await client.query(`
    UPDATE staging_release.read_decisions SET issued_at = $1, pair = $2::jsonb
    WHERE singleton AND issued_at < $1`, [issuedAt, JSON.stringify(pair)]);
  if (update.rowCount !== 1) throw new Error('Renewal publication rejected');
}

async function renew(env, signal) {
  if (env.FL_CONFIRM_STAGING_RENEWAL !== 'approve-continuous-staging-read-only' ||
    env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('Renewal approval required');
  const url = new URL(env.FL_STAGING_DECISION_WRITER_URL);
  const reader = new URL(env.FL_OPERATOR_AUTHORITY_READ_URL);
  if (url.hostname !== reader.hostname || url.pathname !== reader.pathname) throw new Error('Unexpected renewal endpoint');
  const writer = directStagingPool(url.href, stagingConnectionTimeout(env), 'staging_decision_writer');
  try {
    while (!signal.aborted) {
      let interval = 60_000;
      try {
        const decision = await issueStagingPair(env);
        const client = await writer.connect();
        try { await publishStagingPair(client, env.FL_EXPECTED_AUTHORITY_IDENTITY, decision); }
        finally { client.release(); }
        console.log(JSON.stringify({ event: 'staging_decisions_published', expiresAt: decision.issuedAt + 300_000 }));
      } catch {
        interval = 10_000;
        console.error('staging_decision_renewal_failed');
      }
      await delay(interval, undefined, { signal }).catch(error => {
        if (error.name !== 'AbortError') throw error;
      });
    }
  } finally {
    await writer.end();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const stop = new AbortController();
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => stop.abort());
  await renew(process.env, stop.signal).catch(() => {
    console.error('staging_decision_renewal_startup_denied');
    process.exitCode = 1;
  });
}
