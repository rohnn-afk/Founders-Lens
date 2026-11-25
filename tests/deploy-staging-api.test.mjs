import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { deployStagingApi } from '../scripts/deploy-staging-api.mjs';

const id = 'srv-fixture';
const origin = 'https://founders-lens-staging-api.onrender.com';
const digest = 'sha256:4ef05e90cddf434b77a6aebf6041dc1f7b7e52ad01f12ae8f167590f6cd4a18d';
const ref = 'ghcr.io/rohnn-afk/founders-lens-api@' + digest;
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const manifest = { FL_OPERATOR_PUBLIC_KEY: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
const names = ['FL_STAGING_IDEAS_DECISION', 'FL_STAGING_TRANSCRIPT_DECISION'];
const pair = (issuedAt = Date.now()) => Object.fromEntries(names.map((name, index) => {
  const payload = Buffer.from(JSON.stringify({ version: 1, subjectVersions: [1],
    primaryTarget: '7711730470614474440:24576', authorityIdentity: '7711490023970028889:16397',
    issuedAt, expiresAt: issuedAt + 300_000,
    purpose: 'founders-lens:staging-workspace:' + ['read-only', 'read-conversations'][index] }));
  return [name, JSON.stringify({ payload: payload.toString('base64url'),
    signature: sign(null, payload, privateKey).toString('base64url') })];
}));

function fixture({ deployStatus, polledStatus = 'live', serviceName = 'founders-lens-staging-api', drift = false } = {}) {
  const writes = [];
  let reads = 0;
  const request = async (url, options) => {
    if (url.startsWith(origin)) {
      return new Response(null, { status: url.endsWith('/ideas') && !options.headers ? 401 : 200 });
    }
    const path = new URL(url).pathname.split(id)[1];
    if (options.method !== 'GET') writes.push([options.method, path, JSON.parse(options.body)]);
    if (!path) return Response.json({ id, name: serviceName, type: 'web_service', autoDeploy: 'no',
      serviceDetails: { url: origin, runtime: 'image' }, imagePath: ref, registryCredential: { id: 'fixture' } });
    if (path === '/env-vars' && options.method === 'GET') {
      reads++;
      return Response.json(Object.entries({ ...manifest, CUSTOM: drift && reads > 1 ? 'changed' : 'preserved' })
        .map(([key, value]) => ({ envVar: { key, value } })));
    }
    if (path === '/env-vars') return new Response(null, { status: 200 });
    if (options.method === 'POST') return Response.json({ id: 'dep-fixture' }, { status: 201 });
    if (path === '/deploys') return Response.json(deployStatus ? [{ deploy: { status: deployStatus } }] : []);
    return Response.json({ status: polledStatus, image: { ref, sha: digest } });
  };
  return { writes, run: overrides => deployStagingApi({ id, token: 'fixture', manifest, request,
    confirm: async () => true, issue: async () => pair(), report: () => {}, ...overrides }) };
}

test('dry run and canceled confirmation never sign or mutate Render', async () => {
  const { writes, run } = fixture();
  const issue = () => assert.fail('Unexpected signing');
  await run({ dryRun: true, issue });
  await assert.rejects(run({ confirm: async () => false, issue }), /canceled/);
  assert.deepEqual(writes, []);
});

test('a queued deploy beyond the window terminates without issuing a second pair', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 2_000_000 });
  const { run, writes } = fixture({ polledStatus: 'queued' });
  let issued = 0;
  await assert.rejects(run({ issue: async () => { issued++; return pair(); },
    pause: async () => t.mock.timers.tick(300_000) }), /window ended/);
  assert.equal(issued, 1);
  assert.equal(writes.length, 2);
});

test('only one environment update preserves every value and deploys the pinned digest', async () => {
  const { writes, run } = fixture();
  await run({ smokeToken: 'fixture-session' });
  assert.deepEqual(writes.map(([method, path]) => [method, path]), [['PUT', '/env-vars'], ['POST', '/deploys']]);
  assert.deepEqual(writes[0][2].map(entry => entry.key), ['FL_OPERATOR_PUBLIC_KEY', 'CUSTOM', ...names]);
  assert.equal(writes[0][2].find(entry => entry.key === 'CUSTOM').value, 'preserved');
  assert.deepEqual(writes[1][2], { imageUrl: ref });
});

test('rejects a wrong service, queued deploy, configuration race, or expired pair without writes', async () => {
  for (const [options, overrides, message] of [
    [{ serviceName: 'founders-lens-staging-web' }, {}, /target/],
    [{ deployStatus: 'queued' }, {}, /in progress/],
    [{ drift: true }, {}, /changed during signing/],
    [{}, { issue: async () => pair(Date.now() - 301_000) }, /window ended/]
  ]) {
    const { run, writes } = fixture(options);
    await assert.rejects(run(overrides), message);
    assert.deepEqual(writes, []);
  }
});
