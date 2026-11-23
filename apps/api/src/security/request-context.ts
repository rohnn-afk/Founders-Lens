// HTTP middleware support. The app and test router use this module to attach a
// request ID that error handlers can reuse in sanitized responses.

import { randomUUID } from 'node:crypto';
import type { RequestHandler, Response } from 'express';
import type { DenialCategory } from './errors.js';

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

/** Match the submission route shape without carrying any path parameters into diagnostics. */
export function isConversationSubmission(method: string, path: string) {
  return method === 'POST' && /^\/conversations\/[^/]+\/messages\/?$/.test(path);
}

/** Log one submission rejection using server-generated correlation and fixed metadata only. */
export function traceSubmissionFailure(response: Response, status: number,
  category: DenialCategory | 'UNAUTHENTICATED' | 'REQUEST_REJECTED' | 'REQUEST_FAILED') {
  console.info(JSON.stringify({ event: 'submission_rejected', requestId: requestContext(response).requestId,
    route: 'conversation.messages', operation: 'submit', status, category }));
}
