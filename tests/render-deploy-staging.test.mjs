import assert from 'node:assert/strict';
import test from 'node:test';
import { deployStaging } from '../scripts/render-deploy-staging.mjs';

const commit = 'a'.repeat(40);
const env = {
  GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/staging',
  GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: commit, GITHUB_REPOSITORY: 'example/founders-lens',
  RENDER_API_KEY: 'fixture', RENDER_STAGING_API_SERVICE_ID: 'srv-fixtureapi', RENDER_STAGING_WEB_SERVICE_ID: 'srv-fixtureweb'
};

function transport(calls, changes = {}, postStatus = 201) {
  return async (url, init) => {
    calls.push({ url, ...init });
    assert.equal(new URL(url).origin, 'https://api.render.com');
    assert.equal(init.redirect, 'error');
    const id = new URL(url).pathname.split('/')[3];
    if (init.method === 'POST') return new Response(null, { status: postStatus });
    return Response.json({ id, name: id === env.RENDER_STAGING_API_SERVICE_ID
      ? 'founders-lens-staging-api' : 'founders-lens-staging-web',
    type: 'web_service', branch: 'staging', autoDeploy: 'no', autoDeployTrigger: 'off',
    repo: 'https://github.com/example/founders-lens', serviceDetails: { plan: 'free' }, ...changes[id] });
  };
}

test('verifies both staging services before requesting the exact checked commit', async () => {
  const calls = [], events = [];
  await deployStaging(env, transport(calls), event => events.push(JSON.parse(event)));
  assert.deepEqual(calls.map(call => call.method), ['GET', 'GET', 'POST', 'POST']);
  for (const call of calls.slice(2)) assert.deepEqual(JSON.parse(call.body), { commitId: commit });
  assert.deepEqual(events.map(event => event.event), ['staging_deploy_requested', 'staging_deploy_requested']);
});

test('refuses non-staging and rerun contexts without contacting Render', async () => {
  for (const changes of [{ GITHUB_REF: 'refs/heads/main' }, { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_RUN_ATTEMPT: '2' }]) {
    const calls = [];
    await assert.rejects(deployStaging({ ...env, ...changes }, transport(calls)), /configuration rejected/);
    assert.deepEqual(calls, []);
  }
});

test('service mismatch and failed submission never trigger another deploy request', async () => {
  for (const changes of [{ branch: 'main' }, { serviceDetails: { plan: 'starter' } },
    { autoDeployTrigger: 'commit' }, { repo: 'https://github.com/another/repository' }]) {
    const calls = [];
    await assert.rejects(deployStaging(env, transport(calls, { 'srv-fixtureweb': changes })), /release policy/);
    assert.deepEqual(calls.map(call => call.method), ['GET', 'GET']);
  }
  const calls = [];
  await assert.rejects(deployStaging(env, transport(calls, {}, 503)), /deploy request failed/);
  assert.deepEqual(calls.map(call => call.method), ['GET', 'GET', 'POST']);
});
