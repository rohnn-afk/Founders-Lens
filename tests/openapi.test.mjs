import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { validate } from '@scalar/openapi-validator';
import { Router } from 'express';
import { createApp } from '../apps/api/dist/app.js';
import { documentationMode } from '../apps/api/dist/documentation/ui.js';
import { mountDocumentedRouter } from '../apps/api/dist/documentation/routes.js';
import { generation } from '../apps/api/dist/generation/contracts.js';
import { generationRoutes } from '../apps/api/dist/generation/routes.js';
import { SecurityError } from '../apps/api/dist/security/errors.js';
import { messageCreate, messageDto } from '../apps/api/dist/submission/contracts.js';
import { submissionRoutes } from '../apps/api/dist/submission/routes.js';
import { ideaCreate, ideaDto, conversationCreate, conversationDto } from '../apps/api/dist/workspace/contracts.js';
import { localConversationRoutes, workspaceIdeaListRoutes } from '../apps/api/dist/workspace/routes.js';
import { stagingReadRoutes } from '../apps/api/dist/workspace/staging-composition.js';

const origin = 'https://authorized.example.test';
const scopedId = '5ee5d102-62f4-4390-be87-0ad03d50ecd8';
const page = { items: [], page: { hasMore: false, nextCursor: null } };
const reads = {
  idea: async () => { throw new SecurityError('RESOURCE_NOT_FOUND'); },
  conversations: async () => page,
  conversation: async () => { throw new SecurityError('RESOURCE_NOT_FOUND'); },
  history: async () => page
};
const ideas = { ideas: async () => page };
async function authenticate(request) {
  if (request.get('Authorization') === 'Bearer fixture-bound') return { localUserId: 'fixture-bound' };
  if (request.get('Authorization') === 'Bearer fixture-unbound') throw new SecurityError('ACCOUNT_UNAVAILABLE');
  throw new SecurityError('UNAUTHENTICATED');
}

async function serve(t, router, mode) {
  const server = createApp(router, undefined, mode).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

async function readSpec(base) {
  const response = await fetch(base + '/openapi.json');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-type'), /application\/json/);
  const spec = await response.json();
  const result = validate(spec);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  return spec;
}

// Compare public HTTP method registrations independently of the metadata map.
// HEAD is excluded because ideas has an explicit 404 and CORS only admits GET/POST.
function actualOperations(router) {
  return router.stack.flatMap(layer => layer.route
    ? Object.keys(layer.route.methods).filter(method => method !== 'head')
      .map(method => method + ' /api/v1' + layer.route.path.replace(/:(\w+)/g, '{$1}'))
    : layer.handle.stack ? actualOperations(layer.handle) : []);
}

function documentedOperations(spec) {
  return Object.entries(spec.paths).flatMap(([path, methods]) => Object.keys(methods).map(method => method + ' ' + path));
}

function checkCoverage(spec, router) {
  const health = ['get /health/live', 'get /health/ready'];
  assert.deepEqual(documentedOperations(spec).sort(), [...new Set([...health, ...actualOperations(router)])].sort());
  const ids = new Set();
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const operation of Object.values(methods)) {
      assert.ok(operation.operationId && !ids.has(operation.operationId));
      ids.add(operation.operationId);
      assert.deepEqual(operation.security, path.startsWith('/health/') ? [] : [{ ClerkBearer: [] }]);
      assert.deepEqual(operation.parameters.filter(param => param.in === 'path').map(param => param.name),
        [...path.matchAll(/{(\w+)}/g)].map(([, name]) => name));
    }
  }
}

async function checkUi(base, interactive) {
  const response = await fetch(base + '/docs');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.doesNotMatch(response.headers.get('content-security-policy'), /unsafe-eval/);
  const html = await response.text();
  for (const asset of ['swagger-ui.css', 'swagger-ui-bundle.js', 'initialize.js']) {
    assert.ok(html.includes('/docs/' + asset));
    const result = await fetch(base + '/docs/' + asset);
    assert.equal(result.status, 200);
    await result.text();
  }
  assert.equal((await fetch(base + '/docs/oauth2-redirect.html')).status, 404);
  let config;
  runInNewContext(await (await fetch(base + '/docs/initialize.js')).text(), {
    SwaggerUIBundle: value => { config = value; }, URL, window: { location: { origin: base } }
  });
  assert.deepEqual(Array.from(config.supportedSubmitMethods), interactive ? ['get'] : []);
  assert.equal(config.persistAuthorization, false);
  assert.equal(config.queryConfigEnabled, false);
  assert.equal(config.validatorUrl, null);
  const read = url => config.requestInterceptor({ url, method: 'GET' });
  assert.doesNotThrow(() => read('/openapi.json'));
  for (const url of ['/openapi.json', base + '/openapi.json']) {
    const request = config.requestInterceptor({ url });
    assert.equal(request.url, base + '/openapi.json');
    assert.equal(request.method, 'GET');
  }
  assert.throws(() => read('/api/v1/ideas'));
  assert.throws(() => config.requestInterceptor({ url: '/api/v1/ideas' }));
  assert.throws(() => config.requestInterceptor({ url: '/openapi.json', method: 'POST' }));
  assert.throws(() => read('https://other.example.test/openapi.json'));
  assert.throws(() => config.requestInterceptor({ url: '/health/live', method: 'POST' }));
  if (interactive) assert.doesNotThrow(() => read('/health/live'));
  else assert.throws(() => read('/health/live'));
}

test('staging Swagger is reference-only and documents the actual read surface', async t => {
  const router = stagingReadRoutes(origin, authenticate, ideas, {
    ...reads,
    create: async () => assert.fail('staging must not use the supplied write'),
    save: async () => assert.fail('staging must not use the supplied write')
  });
  const base = await serve(t, router);
  const spec = await readSpec(base);
  await checkUi(base, false);
  checkCoverage(spec, router);
  assert.deepEqual(Object.keys(spec.paths).filter(path => path.startsWith('/api/')).sort(), [
    '/api/v1/conversations/{conversationId}',
    '/api/v1/conversations/{conversationId}/messages',
    '/api/v1/ideas',
    '/api/v1/ideas/{ideaId}',
    '/api/v1/ideas/{ideaId}/conversations'
  ]);
  assert.deepEqual(spec.servers, [{ url: '/' }]);
  const text = JSON.stringify(spec);
  assert.doesNotMatch(text, /postgres(?:ql)?:\/\/|-----BEGIN|fixture-bound|authorized\.example|eyJ[A-Za-z\d_-]{12}|signingKey|clientSecret/i);
  assert.ok(!text.includes(scopedId));
  assert.deepEqual(spec.components.securitySchemes.ClerkBearer.type, 'http');
  assert.equal(spec.components.securitySchemes.ClerkBearer.scheme, 'bearer');

  for (const [path, { get }] of Object.entries(spec.paths)) {
    if (!path.startsWith('/api/')) continue;
    assert.ok(get.responses[401]);
    const endpoint = base + path.replace(/{\w+}/g, scopedId);
    assert.equal((await fetch(endpoint)).status, 401);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { Origin: origin, Authorization: 'Bearer fixture-bound' } })).status, 404);
  }
  const list = base + '/api/v1/ideas';
  assert.equal((await fetch(list, { headers: { Authorization: 'Bearer fixture-unbound' } })).status, 403);
  assert.equal((await fetch(list, { headers: { Origin: base, Authorization: 'Bearer fixture-bound' } })).status, 403);
  assert.deepEqual(await (await fetch(list, { headers: { Origin: origin, Authorization: 'Bearer fixture-bound' } })).json(), page);
  assert.equal((await fetch(base + '/api/v1/ideas/' + scopedId, { headers: { Authorization: 'Bearer fixture-bound' } })).status, 404);
});

test('locally admitted operations include accurate request and response contracts', async t => {
  const router = Router();
  const unused = async () => assert.fail('fixture route called unexpectedly');
  mountDocumentedRouter(router, workspaceIdeaListRoutes(ideas, authenticate, { createIdea: unused }));
  mountDocumentedRouter(router, submissionRoutes({}, authenticate, { readConversation: scopedId }));
  mountDocumentedRouter(router, generationRoutes({}, authenticate, { statusOnly: true }));
  mountDocumentedRouter(router, localConversationRoutes({ ...reads, create: unused, save: unused }, authenticate));
  const base = await serve(t, router, 'local-health');
  const spec = await readSpec(base);
  checkCoverage(spec, router);
  await checkUi(base, true);
  const paths = spec.paths;
  const operations = [
    [paths['/api/v1/ideas'].post, ideaCreate, ideaDto, 201],
    [paths['/api/v1/ideas/{ideaId}/conversations'].post, conversationCreate, conversationDto, 201],
    [paths['/api/v1/conversations/{conversationId}/messages/save'].post, messageCreate, messageDto, 201],
    [paths['/api/v1/conversations/{conversationId}/messages'].post, messageCreate, null, 202],
    [paths['/api/v1/generations/{generationId}'].get, null, generation, 200]
  ];
  for (const [op, input, output, status] of operations) {
    if (input) {
      const media = op.requestBody.content['application/json'];
      assert.ok(input.safeParse(media.example).success);
      assert.equal(media.schema.additionalProperties, false);
      assert.equal(op.requestBody.required, true);
    }
    if (output) {
      const media = op.responses[status].content['application/json'];
      assert.ok(output.safeParse(media.example).success);
      assert.equal(media.schema.additionalProperties, false);
    }
  }
  const create = paths['/api/v1/ideas'].post;
  assert.equal(create.requestBody.content['application/json'].schema.properties.title.maxLength, 200);
  assert.equal(create.requestBody.content['application/json'].schema.properties.summary.maxLength, 5000);
  assert.ok(create.responses[201].headers.ETag);
  assert.ok(create.responses[201].headers.Location);
  const messages = paths['/api/v1/conversations/{conversationId}/messages'];
  assert.equal(messages.post.requestBody.content['application/json'].schema.properties.content.maxLength, 10000);
  assert.deepEqual(messages.get.parameters.find(param => param.name === 'assistantResponseVersion').schema.enum, ['1', '2']);
  assert.equal(messages.get.responses[200].content['application/json'].example.page.nextCursor, null);
  assert.ok(!JSON.stringify(spec).includes(scopedId));
});

test('documentation modes apply without changing health or exposing disabled routes', async t => {
  assert.equal(documentationMode({ FL_DEPLOYMENT: 'staging', NODE_ENV: 'production' }), 'reference');
  assert.equal(documentationMode({ FL_API_DOCS: 'off' }), 'off');
  assert.equal(documentationMode({ FL_API_DOCS: 'local-health' }), 'local-health');
  for (const env of [{ NODE_ENV: 'production' }, { FL_DEPLOYMENT: 'staging' }]) {
    assert.throws(() => documentationMode({ ...env, FL_API_DOCS: 'local-health' }));
  }
  assert.throws(() => documentationMode({ FL_API_DOCS: 'true' }));
  const off = await serve(t, undefined, 'off');
  for (const path of ['/docs', '/openapi.json', '/docs/swagger-ui-bundle.js']) {
    assert.equal((await fetch(off + path)).status, 404);
  }
  assert.equal((await fetch(off + '/health/live')).status, 200);
  const shell = await serve(t);
  assert.deepEqual(documentedOperations(await readSpec(shell)).sort(), ['get /health/live', 'get /health/ready']);
});
