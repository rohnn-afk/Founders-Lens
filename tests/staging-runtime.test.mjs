import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from '../apps/api/dist/app.js';
import { stagingConfig } from '../apps/api/dist/workspace/staging-config.js';
import { workspaceIdeasCors } from '../apps/api/dist/workspace/read-only-composition.js';
import { Router } from 'express';

const settings = {
  NODE_ENV: 'production', FL_DEPLOYMENT: 'staging', PORT: '8080',
  FL_WEB_ORIGIN: 'https://web.example.test',
  FL_WORKSPACE_DATABASE_URL: 'postgresql://fl_p6_workspace:fixture@primary-postgres.railway.internal/founders_lens_staging',
  FL_CONVERSATIONS_DATABASE_URL: 'postgresql://fl_p8_conversations:fixture@primary-postgres.railway.internal/founders_lens_staging',
  FL_AUTHORITY_DATABASE_URL: 'postgresql://ledger_reader:fixture@privacy-postgres.railway.internal/ledger'
};

test('staging requires exact origins, independent private services and restricted credentials', () => {
  assert.equal(stagingConfig(settings).port, 8080);
  for (const changes of [
    { NODE_ENV: 'development' }, { RAILWAY_ENVIRONMENT_NAME: 'production' },
    { PORT: '0' }, { PORT: '1e3' }, { FL_WEB_ORIGIN: 'https://web.example.test/' },
    { FL_WEB_ORIGIN: 'http://web.example.test' }, { GROQ_API_KEY: 'fixture' }, { FL_P9_SUBMIT: '1' },
    { FL_CONVERSATIONS_DATABASE_URL: settings.FL_WORKSPACE_DATABASE_URL },
    { FL_AUTHORITY_DATABASE_URL: settings.FL_AUTHORITY_DATABASE_URL.replace('privacy-postgres', 'primary-postgres') },
    { FL_AUTHORITY_DATABASE_URL: settings.FL_AUTHORITY_DATABASE_URL.replace('privacy-postgres.railway.internal', '127.0.0.1') }
  ]) assert.throws(() => stagingConfig({ ...settings, ...changes }));
});

test('Render requires private primary logins and a verified TLS authority endpoint', () => {
  const render = {
    ...settings, RENDER: 'true',
    FL_WORKSPACE_DATABASE_URL: settings.FL_WORKSPACE_DATABASE_URL.replace('primary-postgres.railway.internal', 'dpg-fixture-a'),
    FL_CONVERSATIONS_DATABASE_URL: settings.FL_CONVERSATIONS_DATABASE_URL.replace('primary-postgres.railway.internal', 'dpg-fixture-a'),
    FL_AUTHORITY_DATABASE_URL: 'postgresql://ledger_reader:fixture@authority.example.test/suppression_proof?sslmode=verify-full'
  };
  assert.equal(stagingConfig(render).bindHost, '0.0.0.0');
  assert.equal(stagingConfig(settings).bindHost, '::');
  for (const authority of [
    render.FL_AUTHORITY_DATABASE_URL.replace('verify-full', 'require'),
    render.FL_AUTHORITY_DATABASE_URL.replace('?sslmode=verify-full', ''),
    render.FL_AUTHORITY_DATABASE_URL + '&sslmode=disable',
    render.FL_AUTHORITY_DATABASE_URL.replace('authority.example.test', '127.0.0.1')
  ]) assert.throws(() => stagingConfig({ ...render, FL_AUTHORITY_DATABASE_URL: authority }));
  assert.throws(() => stagingConfig({ ...render, NODE_TLS_REJECT_UNAUTHORIZED: '0' }));
  assert.throws(() => stagingConfig({ ...render, FL_WORKSPACE_DATABASE_URL: settings.FL_WORKSPACE_DATABASE_URL }));
});

test('readiness fails when dependency evidence is lost and browser CORS remains exact and read only', async t => {
  let verified = true;
  const router = Router();
  router.use(workspaceIdeasCors(false, { create: false, save: false }, undefined, settings.FL_WEB_ORIGIN));
  router.get('/ideas', (req, res) => res.sendStatus(req.get('Authorization') === 'Bearer fixture' ? 200 : 401));
  const server = createApp(router, async () => { if (!verified) throw new Error('Fixture outage'); }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = 'http://127.0.0.1:' + server.address().port;
  const headers = { Origin: settings.FL_WEB_ORIGIN, Authorization: 'Bearer fixture' };
  assert.equal((await fetch(endpoint + '/health/ready')).status, 200);
  const preflight = await fetch(endpoint + '/api/v1/ideas', { method: 'OPTIONS', headers: {
    Origin: settings.FL_WEB_ORIGIN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization'
  } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), settings.FL_WEB_ORIGIN);
  assert.equal((await fetch(endpoint + '/api/v1/ideas', { headers })).status, 200);
  assert.equal((await fetch(endpoint + '/api/v1/ideas', { headers: { Origin: settings.FL_WEB_ORIGIN } })).status, 401);
  assert.equal((await fetch(endpoint + '/api/v1/ideas', { headers: { ...headers, Origin: 'https://foreign.example.test' } })).status, 403);
  assert.equal((await fetch(endpoint + '/api/v1/ideas', { method: 'POST', headers })).status, 404);
  verified = false;
  assert.equal((await fetch(endpoint + '/health/ready')).status, 503);
  assert.equal((await fetch(endpoint + '/health/live')).status, 200);
});

test('Render accepts a separate direct Oregon Neon primary with verified TLS', () => {
  const host = 'ep-workspace-fixture.us-west-2.aws.neon.tech';
  const connection = (role, target = host) =>
    'postgresql://' + role + ':fixture@' + target + '/founders_lens_staging?sslmode=verify-full';
  const neon = {
    ...settings, RENDER: 'true', FL_STAGING_PRIMARY_PROVIDER: 'neon',
    FL_WORKSPACE_DATABASE_URL: connection('fl_p6_workspace'),
    FL_CONVERSATIONS_DATABASE_URL: connection('fl_p8_conversations'),
    FL_AUTHORITY_DATABASE_URL: 'postgresql://ledger_reader:fixture@ep-authority.us-west-2.aws.neon.tech/ledger?sslmode=verify-full'
  };
  assert.equal(stagingConfig(neon).workspace.hostname, host);
  for (const changes of [
    { FL_STAGING_PRIMARY_PROVIDER: 'unknown' },
    { FL_STAGING_PRIMARY_PROVIDER: undefined },
    { RENDER: undefined },
    { FL_WORKSPACE_DATABASE_URL: neon.FL_WORKSPACE_DATABASE_URL.replace('verify-full', 'require') },
    { FL_WORKSPACE_DATABASE_URL: connection('fl_p6_workspace', host.replace('.', '-pooler.')) },
    { FL_WORKSPACE_DATABASE_URL: connection('fl_p6_workspace', host + ':5433') },
    { FL_CONVERSATIONS_DATABASE_URL: connection('fl_p8_conversations', host.replace('workspace', 'other')) },
    { FL_AUTHORITY_DATABASE_URL: connection('ledger_reader', host.replace('.', '-pooler.')) }
  ]) assert.throws(() => stagingConfig({ ...neon, ...changes }));
});
