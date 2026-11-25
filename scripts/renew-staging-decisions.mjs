import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { directStagingPool, issueStagingPair } from './staging-sign-read.mjs';
import { stagingConnectionTimeout } from '../apps/api/dist/workspace/staging-config.js';

export async function publishStagingPair(client, expectedAuthority, { issuedAt, pair }) {
  const requireFresh = () => {
    const now = Date.now();
    if (!Number.isSafeInteger(issuedAt) || issuedAt > now || issuedAt + 60_000 <= now) {
      throw new Error('Renewal evidence is stale');
    }
  };
  requireFresh();
  const { rows } = await client.query(`
    SELECT system_identifier::text || ':' || d.oid::text AS identity
    FROM pg_catalog.pg_control_system(), pg_catalog.pg_database d WHERE d.datname=current_database()`);
  if (rows[0]?.identity !== expectedAuthority) throw new Error('Unexpected renewal database');
  requireFresh();
  const update = await client.query(`
    UPDATE staging_release.read_decisions SET issued_at = $1, pair = $2::jsonb
    WHERE singleton AND issued_at < $1`, [issuedAt, JSON.stringify(pair)]);
  if (update.rowCount !== 1) throw new Error('Renewal publication rejected');
}

function notifyPublished(env) {
  if (!env.NOTIFY_SOCKET) return;
  execFileSync('/usr/bin/systemd-notify', ['--ready', 'WATCHDOG=1'], { timeout: 5000, stdio: 'ignore' });
}

export async function renew(env, signal, { operatorKey, report = console.log } = {}) {
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
        const decision = await issueStagingPair(env, operatorKey);
        const client = await writer.connect();
        try { await publishStagingPair(client, env.FL_EXPECTED_AUTHORITY_IDENTITY, decision); }
        finally { client.release(); }
        report(JSON.stringify({ event: 'staging_decisions_published', expiresAt: decision.issuedAt + 300_000 }));
        notifyPublished(env);
      } catch {
        interval = 10_000;
        report('staging_decision_renewal_failed');
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
