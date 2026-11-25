// Express application layer. The startup module calls this factory to assemble
// public health endpoints and request middleware without opening a listener.

import express, { Router } from 'express';
import { documentedRoute, workspacePrefix } from './documentation/routes.js';
import { mountDocumentation, type DocumentationMode } from './documentation/ui.js';
import helmet from 'helmet';
import { attachRequestContext, isConversationSubmission, traceSubmissionFailure } from './security/request-context.js';
import { securityErrorHandler } from './security/errors.js';

export function createApp(workspace?: Router, readiness?: () => Promise<void>, docs: DocumentationMode = 'reference') {
  const app = express();
  app.disable('x-powered-by');
  // Middleware runs in order before the route handler. Here it adds security
  // headers and a request ID so even errors can be correlated safely.
  app.use(helmet());
  app.use(attachRequestContext);
  app.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  const health = Router();
  documentedRoute(health, 'get', '/health/live', (_request, response) => { response.status(200).end(); });
  documentedRoute(health, 'get', '/health/ready', async (_request, response) => {
    if (!readiness) { response.status(503).end(); return; }
    try {
      await readiness();
      response.status(200).end();
    } catch {
      response.status(503).end();
    }
  });
  app.use(health);
  mountDocumentation(app, docs, health, workspace);
  if (workspace) app.use(workspacePrefix, workspace);
  app.use((request, response) => {
    if (isConversationSubmission(request.method, request.path.replace(/^\/api\/v1(?=\/)/, ''))) {
      traceSubmissionFailure(response, 404, 'WRONG_ROUTE');
    }
    response.status(404).end();
  });
  app.use(securityErrorHandler);
  return app;
}
