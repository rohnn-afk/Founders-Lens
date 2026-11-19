import type { ErrorRequestHandler } from 'express';
import { requestContext } from './request-context.js';

type Code = 'UNAUTHENTICATED' | 'ACCOUNT_UNAVAILABLE' | 'RESOURCE_NOT_FOUND' | 'DEPENDENCY_UNAVAILABLE' | 'INTERNAL_ERROR';
const catalog = {
  UNAUTHENTICATED: { status: 401, message: 'Authentication is required.', retryable: false },
  ACCOUNT_UNAVAILABLE: { status: 403, message: 'The account is unavailable.', retryable: false },
  RESOURCE_NOT_FOUND: { status: 404, message: 'The requested resource was not found.', retryable: false },
  DEPENDENCY_UNAVAILABLE: { status: 503, message: 'A required dependency is unavailable.', retryable: true },
  INTERNAL_ERROR: { status: 500, message: 'An internal error occurred.', retryable: false }
} as const;

export class SecurityError extends Error {
  constructor(readonly code: Code) { super(catalog[code].message); }
}

export function securityFailure(error: unknown, requestId: string) {
  const code = error instanceof SecurityError ? error.code : 'INTERNAL_ERROR';
  const { status, message, retryable } = catalog[code];
  return { status, body: { error: { code, message, requestId, retryable } } };
}

export const securityErrorHandler: ErrorRequestHandler = (error: unknown, _request, response, next) => {
  if (response.headersSent) { next(new SecurityError('INTERNAL_ERROR')); return; }
  const failure = securityFailure(error, requestContext(response).requestId);
  response.setHeader('Cache-Control', 'no-store');
  response.status(failure.status).json(failure.body);
};
