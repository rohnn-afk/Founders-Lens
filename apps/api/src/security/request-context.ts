// HTTP middleware support. The app and test router use this module to attach a
// request ID that error handlers can reuse in sanitized responses.

import { randomUUID } from 'node:crypto';
import type { RequestHandler, Response } from 'express';

interface RequestContext { readonly requestId: string }
// A WeakMap associates context with the response without keeping the response
// alive after the request has finished.
const contexts = new WeakMap<Response, RequestContext>();
export function requestContext(response: Response): RequestContext {
  let context = contexts.get(response);
  if (!context) { context = Object.freeze({ requestId: randomUUID() }); contexts.set(response, context); }
  return context;
}
export const attachRequestContext: RequestHandler = (_request, response, next) => {
  response.setHeader('X-Request-Id', requestContext(response).requestId);
  next();
};
