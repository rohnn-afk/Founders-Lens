import assert from 'node:assert/strict';

const origin = 'https://founders-lens-staging-api.onrender.com';
const request = path => fetch(origin + path, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
const [docs, spec, initializer, bundle] = await Promise.all([
  '/docs', '/openapi.json', '/docs/initialize.js', '/docs/swagger-ui-bundle.js'
].map(request));
assert.deepEqual([docs.status, spec.status, initializer.status, bundle.status], [200, 200, 200, 200]);
assert.match(await docs.text(), /\/docs\/swagger-ui-bundle\.js/);
assert.match(await initializer.text(), /supportedSubmitMethods: \[\]/);
await bundle.body?.cancel();
const document = await spec.json();
assert.equal(document.openapi, '3.1.0');
assert.deepEqual(Object.keys(document.paths).sort(), [
  '/api/v1/conversations/{conversationId}', '/api/v1/conversations/{conversationId}/messages',
  '/api/v1/ideas', '/api/v1/ideas/{ideaId}', '/api/v1/ideas/{ideaId}/conversations',
  '/health/live', '/health/ready'
]);
for (const [path, methods] of Object.entries(document.paths)) {
  assert.deepEqual(Object.keys(methods), ['get']);
  assert.deepEqual(methods.get.security, path.startsWith('/api/') ? [{ ClerkBearer: [] }] : []);
}
console.log('Staging Swagger and OpenAPI verified the guarded read surface.');
