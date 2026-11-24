import assert from 'node:assert/strict';
import test from 'node:test';
import { deployStaging } from '../scripts/render-deploy-staging.mjs';

const sourceRevision = 'a'.repeat(40);
const image = 'ghcr.io/rohnn-afk/founders-lens-api';
const reference = image + '@sha256:' + 'b'.repeat(64);
const platform = 'sha256:' + 'c'.repeat(64);
const release = { reference, sourceRevision, linuxAmd64ManifestDigest: platform };
const api = 'https://founders-lens-staging-api.onrender.com';
const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/staging',
  GITHUB_SHA: sourceRevision, GITHUB_REPOSITORY: 'rohnn-afk/Founders-Lens',
  RENDER_STAGING_API_SERVICE_ID: 'srv-fixture', RENDER_API_KEY: 'fixture' };

function transport(calls, { service = {}, mode = 'authority', status = 'live', sha = platform, denied = 401,
  history = [], submission = 201 } = {}) {
  return async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, ...init });
    assert.equal(init.redirect, 'error');
    if (url.startsWith(api)) {
      assert.equal(init.headers, undefined);
      return new Response(null, { status: path.startsWith('/health/') ? 200 : denied });
    }
    assert.equal(new URL(url).origin, 'https://api.render.com');
    assert.match(path, /^\/v1\/services\/srv-fixture(?:\/|$)/);
    if (path.endsWith('/srv-fixture')) return Response.json({ id: 'srv-fixture', name: 'founders-lens-staging-api',
      type: 'web_service', autoDeploy: 'no', imagePath: reference,
      serviceDetails: { runtime: 'image', url: api, healthCheckPath: '/health/ready' }, ...service });
    if (path.includes('/env-vars/')) return Response.json({ value: mode });
    if (init.method === 'POST') return Response.json({ id: 'dep-fixture' }, { status: submission });
    if (path.endsWith('/deploys')) return Response.json(history);
    return Response.json({ status, image: { ref: reference, sha } });
  };
}

const run = (calls, options) => deployStaging(env, release, transport(calls, options), async () => {}, () => {});

test('deploys only the staging API by digest and checks readiness and denial', async () => {
  const calls = [];
  await run(calls);
  assert.deepEqual(calls.filter(c => c.method === 'POST').map(c => JSON.parse(c.body)), [{ imageUrl: reference }]);
  assert.deepEqual(calls.slice(-3).map(c => c.path), ['/health/live', '/health/ready', '/api/v1/ideas']);
});

test('refuses unsafe context, demo target, missing renewal or active deploy', async () => {
  const calls = [];
  await assert.rejects(deployStaging({ ...env, GITHUB_REF: 'refs/heads/main' }, release, transport(calls)), /configuration rejected/);
  assert.equal(calls.length, 0);
  await assert.rejects(run(calls, { service: { name: 'founders-lens-staging-web' } }), /policy/);
  await assert.rejects(run(calls, { mode: 'environment' }), /renewal/);
  await assert.rejects(run(calls, { history: [{ deploy: { status: 'update_in_progress' } }] }), /active deploy/);
  assert.equal(calls.filter(c => c.method === 'POST').length, 0);
});

test('fails on rejected submission, wrong digest, failed deployment or leaked workspace', async () => {
  await assert.rejects(run([], { submission: 503 }), /HTTP 503/);
  await assert.rejects(run([], { sha: 'sha256:' + 'd'.repeat(64) }), /live digest/);
  await assert.rejects(run([], { status: 'update_failed' }), /deploy failed/);
  await assert.rejects(run([], { denied: 200 }), /unauthenticated read/);
  await assert.rejects(run([], { status: 'queued' }), /timed out/);
});
