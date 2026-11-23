// Express application layer. The startup module calls this factory to assemble
// public health endpoints and request middleware without opening a listener.

import express, { type Router } from 'express';
import helmet from 'helmet';
import { attachRequestContext, isConversationSubmission, traceSubmissionFailure } from './security/request-context.js';
import { securityErrorHandler } from './security/errors.js';

export function createApp(workspace?: Router, readiness?: () => Promise<void>) {
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
  app.get('/health/live', (_request, response) => { response.status(200).end(); });
  app.get('/health/ready', async (_request, response) => {
    if (!readiness) { response.status(503).end(); return; }
    try {
      await readiness();
      response.status(200).end();
    } catch {
      response.status(503).end();
    }
  });
  if (workspace) app.use('/api/v1', workspace);
  app.use((request, response) => {
    if (isConversationSubmission(request.method, request.path.replace(/^\/api\/v1(?=\/)/, ''))) {
      traceSubmissionFailure(response, 404, 'WRONG_ROUTE');
    }
    response.status(404).end();
  });
  app.use(securityErrorHandler);
  return app;
}
