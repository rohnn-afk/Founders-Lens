// Express application layer. The startup module calls this factory to assemble
// public health endpoints and request middleware without opening a listener.

import express, { type Router } from 'express';
import helmet from 'helmet';
import { attachRequestContext } from './security/request-context.js';
import { securityErrorHandler } from './security/errors.js';

export function createApp(localIdeas?: Router) {
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
  // No production dependency or safety gate has been configured or verified.
  app.get('/health/ready', (_request, response) => { response.status(503).end(); });
  if (localIdeas) app.use('/api/v1', localIdeas);
  app.use((_request, response) => { response.status(404).end(); });
  app.use(securityErrorHandler);
  return app;
}
