import type { RequestHandler, Router } from 'express';

export const workspacePrefix = '/api/v1';
export type DocumentedMethod = 'get' | 'post' | 'patch';
export type RegisteredOperation = { method: DocumentedMethod; path: string };
const registrations = new WeakMap<Router, RegisteredOperation[]>();

function record(router: Router, operations: RegisteredOperation[]) {
  registrations.set(router, [...(registrations.get(router) ?? []), ...operations]);
}

export function documentedRoute(router: Router, method: DocumentedMethod, path: string, handler: RequestHandler) {
  router[method](path, handler);
  record(router, [{ method, path }]);
}

export function registeredOperations(router?: Router): readonly RegisteredOperation[] {
  return (router && registrations.get(router)) || [];
}

export function mountDocumentedRouter(parent: Router, child: Router) {
  parent.use(child);
  record(parent, [...registeredOperations(child)]);
}
