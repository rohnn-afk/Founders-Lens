import { randomUUID } from 'node:crypto';
import type { RequestHandler, Response } from 'express';

interface RequestContext { readonly requestId: string }
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
