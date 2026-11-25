import { createRequire } from 'node:module';
import type { Router } from 'express';
import { openApi } from './specification.js';
import { registeredOperations } from './routes.js';

export type DocumentationMode = 'off' | 'reference' | 'local-health';

export function documentationMode(env: NodeJS.ProcessEnv): DocumentationMode {
  const value = env['FL_API_DOCS'] ?? 'reference';
  if (value === 'off' || value === 'reference') return value;
  if (value === 'local-health' && env['FL_DEPLOYMENT'] === undefined && env['NODE_ENV'] !== 'production') return value;
  throw new Error('Invalid API documentation mode.');
}

const require = createRequire(import.meta.url);

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Founder’s Lens API</title>
  <link rel="stylesheet" href="/docs/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/docs/swagger-ui-bundle.js" defer></script>
  <script src="/docs/initialize.js" defer></script>
</body>
</html>`;

export function mountDocumentation(app: Router, mode: DocumentationMode, health: Router, workspace?: Router) {
  if (mode === 'off') return;
  const spec = openApi(registeredOperations(health), registeredOperations(workspace));
  app.get('/openapi.json', (_request, response) => { response.json(spec); });
  app.get('/docs', (_request, response) => { response.type('html').send(html); });
  for (const asset of ['swagger-ui.css', 'swagger-ui-bundle.js']) {
    const filename = require.resolve('swagger-ui-dist/' + asset);
    app.get('/docs/' + asset, (_request, response) => { response.sendFile(filename, { cacheControl: false }); });
  }
  const methods = mode === 'local-health' ? ['get'] : [];
  const initializer = `SwaggerUIBundle({
    dom_id: '#swagger-ui',
    url: '/openapi.json',
    deepLinking: true,
    queryConfigEnabled: false,
    persistAuthorization: false,
    validatorUrl: null,
    supportedSubmitMethods: ${JSON.stringify(methods)},
    requestInterceptor: request => {
      const url = new URL(request.url, window.location.origin);
      // Swagger Client omits the method when it downloads the specification.
      const method = (request.method ?? 'GET').toUpperCase();
      const allowed = url.pathname === '/openapi.json' ||
        (${mode === 'local-health'} && ['/health/live', '/health/ready'].includes(url.pathname));
      if (url.origin !== window.location.origin || method !== 'GET' || !allowed) {
        throw new Error('This documentation cannot execute that request.');
      }
      return { ...request, url: url.href, method };
    },
    plugins: [() => ({
      components: { authorizeBtn: () => null, authorizeOperationBtn: () => null, curl: () => null },
      statePlugins: {
        spec: {
          wrapSelectors: {
            allowTryItOutFor: (original) => (path, method) =>
              path.startsWith('/health/') && original(path, method)
          }
        }
      }
    })]
  });`;
  app.get('/docs/initialize.js', (_request, response) => { response.type('js').send(initializer); });
}
