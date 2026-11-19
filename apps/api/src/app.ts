import express from 'express';
import helmet from 'helmet';
import { attachRequestContext } from './security/request-context.js';
import { securityErrorHandler } from './security/errors.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(attachRequestContext);
  app.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.get('/health/live', (_request, response) => { response.status(200).end(); });
  // No production dependency or safety gate has been configured or verified.
  app.get('/health/ready', (_request, response) => { response.status(503).end(); });
  app.use((_request, response) => { response.status(404).end(); });
  app.use(securityErrorHandler);
  return app;
}
