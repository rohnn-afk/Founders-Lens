// Adapts the workspace service to the eight HTTP routes in an isolated harness.
import { documentedRoute } from '../documentation/routes.js';
import { json, Router, type Request, type Response } from 'express';
import { SecurityError, securityFailure } from '../security/errors.js';
import type { Principal } from '../security/principal.js';
import { attachRequestContext, requestContext } from '../security/request-context.js';
import { conversationCreate, emptyQuery, etag, ideaCreate, ideaDetailsPatch, ideaPatch, idempotencyKey, ifMatch, input,
  listQuery, preferencesPatch, uuid, WorkspaceError } from './contracts.js';
import type { WorkspaceService } from './service.js';
import { messageCreate, SubmissionError, transcriptQuery, type MessageCreate, type TranscriptQuery } from '../submission/contracts.js';
import type { z } from 'zod';

type Authenticate = (request: Request) => Promise<Principal>;
type Handler = (request: Request, response: Response, principal: Principal) => Promise<void>;
// The router needs only these operations. Any object with matching methods
// can be supplied, so HTTP tests do not need to construct a service or database.
type WorkspaceRouteOperations = Pick<WorkspaceService,
  'ideas' | 'createIdea' | 'idea' | 'patchIdea' | 'conversations' | 'createConversation' | 'conversation' | 'preferences'>;

const parseJson = json({ limit: '64kb' });
function sendReadDto(response: Response, dto: unknown): void {
  // Express json() can turn a matching cache validator into 304. These no-store
  // reads require a 200 DTO, even though the version ETag is useful for writes.
  response.status(200).type('application/json').end(JSON.stringify(dto));
}
function readSingleHeader(request: Request, name: string) {
  const names = request.rawHeaders.filter((_, i) => i % 2 === 0 && request.rawHeaders[i]?.toLowerCase() === name);
  if (names.length > 1) throw new WorkspaceError(400, 'VALIDATION_ERROR');
  return request.get(name);
}
function parseRequestBody(request: Request, response: Response, parser = parseJson): Promise<void> {
  if (!request.is('application/json')) throw new WorkspaceError(415, 'UNSUPPORTED_MEDIA_TYPE');
  return new Promise((resolve, reject) => parser(request, response, error => {
    if (!error) resolve();
    else reject(error.status === 413 ? new WorkspaceError(413, 'PAYLOAD_TOO_LARGE')
      : new WorkspaceError(400, 'VALIDATION_ERROR'));
  }));
}

/** Authenticate before validation and keep private errors and responses out of caches. */
function authenticatedRequest(authenticate: Authenticate, action: Handler) {
  return async (request: Request, response: Response) => {
    response.set('Cache-Control', 'no-store');
    const requestId = requestContext(response).requestId;
    try {
      const principal = await authenticate(request);
      if (!principal) throw new SecurityError('UNAUTHENTICATED');
      if (request.method === 'GET' && (request.get('transfer-encoding') || Number(request.get('content-length') ?? 0) > 0)) {
        throw new WorkspaceError(400, 'VALIDATION_ERROR');
      }
      await action(request, response, principal);
    } catch (error) {
      const failure = error instanceof SubmissionError ? error.failure(requestId) : error instanceof WorkspaceError
        ? { status: error.status, body: { error: { code: error.code, message: 'The workspace request could not be completed.',
          requestId, retryable: error.status === 503 } } }
        : securityFailure(error, requestId);
      response.status(failure.status).json(failure.body);
    }
  };
}

export type LocalConversationOperations = {
  idea(principal: Principal, id: string): Promise<unknown>;
  conversations(principal: Principal, id: string, query: z.infer<typeof listQuery>): Promise<unknown>;
  conversation(principal: Principal, id: string): Promise<unknown>;
  history(principal: Principal, id: string, query: TranscriptQuery): Promise<unknown>;
  create?: (principal: Principal, id: string, body: z.infer<typeof conversationCreate>) => Promise<unknown>;
  save?: (principal: Principal, id: string, key: string, body: MessageCreate) => Promise<unknown>;
};

/** Mount the local conversation contract without mounting the generation submission router. */
export function localConversationRoutes(operations: LocalConversationOperations, authenticate: Authenticate): Router {
  const router = Router();
  const handle = (action: Handler) => authenticatedRequest(authenticate, action);
  const routeId = (request: Request, name: string) => input(uuid, request.params[name]);
  documentedRoute(router, 'get', '/ideas/:ideaId', handle(async (req, res, principal) => {
    input(emptyQuery, req.query);
    sendReadDto(res, await operations.idea(principal, routeId(req, 'ideaId')));
  }));
  documentedRoute(router, 'get', '/ideas/:ideaId/conversations', handle(async (req, res, principal) => {
    sendReadDto(res, await operations.conversations(principal, routeId(req, 'ideaId'), input(listQuery, req.query)));
  }));
  documentedRoute(router, 'get', '/conversations/:conversationId', handle(async (req, res, principal) => {
    input(emptyQuery, req.query);
    sendReadDto(res, await operations.conversation(principal, routeId(req, 'conversationId')));
  }));
  documentedRoute(router, 'get', '/conversations/:conversationId/messages', handle(async (req, res, principal) => {
    sendReadDto(res, await operations.history(principal, routeId(req, 'conversationId'), input(transcriptQuery, req.query)));
  }));
  if (operations.create) {
    const create = operations.create;
    documentedRoute(router, 'post', '/ideas/:ideaId/conversations', handle(async (req, res, principal) => {
      input(emptyQuery, req.query);
      const id = routeId(req, 'ideaId');
      await parseRequestBody(req, res);
      res.status(201).json(await create(principal, id, input(conversationCreate, req.body)));
    }));
  }
  if (operations.save) {
    const save = operations.save;
    const messageJson = json({ limit: '128kb' });
    documentedRoute(router, 'post', '/conversations/:conversationId/messages/save', handle(async (req, res, principal) => {
      input(emptyQuery, req.query);
      const id = routeId(req, 'conversationId');
      const key = input(idempotencyKey, readSingleHeader(req, 'idempotency-key'));
      await parseRequestBody(req, res, messageJson);
      res.status(201).json(await save(principal, id, key, input(messageCreate, req.body)));
    }));
  }
  return router;
}

/** Register idea listing and any separately admitted local write operations. */
export function workspaceIdeaListRoutes(service: Pick<WorkspaceService, 'ideas'>, authenticate: Authenticate,
  create?: Pick<WorkspaceService, 'createIdea'>, edit?: Pick<WorkspaceService, 'patchIdea'>): Router {
  const router = Router();
  router.use(attachRequestContext);
  // Express ordinarily treats HEAD as GET. The local slice admits only GET.
  router.head('/ideas', (_request, response) => { response.set('Cache-Control', 'no-store').status(404).end(); });
  documentedRoute(router, 'get', '/ideas', authenticatedRequest(authenticate, listIdeas(service)));
  if (create) documentedRoute(router, 'post', '/ideas', authenticatedRequest(authenticate, createIdea(create)));
  if (edit) documentedRoute(router, 'patch', '/ideas/:ideaId', authenticatedRequest(authenticate, patchIdea(edit, ideaDetailsPatch)));
  return router;
}

function patchIdea(service: Pick<WorkspaceService, 'patchIdea'>, contract: z.ZodType<z.infer<typeof ideaPatch>>): Handler {
  return async (req, res, principal) => {
    input(emptyQuery, req.query);
    const id = input(uuid, req.params['ideaId']), match = ifMatch(readSingleHeader(req, 'if-match'), true);
    await parseRequestBody(req, res);
    const result = await service.patchIdea(principal, id, match, input(contract, req.body));
    sendReadDto(res.set('ETag', etag(result.version)), result);
  };
}

function createIdea(service: Pick<WorkspaceService, 'createIdea'>): Handler {
  return async (req, res, principal) => {
    input(emptyQuery, req.query);
    const key = input(idempotencyKey, readSingleHeader(req, 'idempotency-key'));
    await parseRequestBody(req, res);
    const result = await service.createIdea(principal, key, input(ideaCreate, req.body));
    res.status(201).set('ETag', etag(result.version)).location('/api/v1/ideas/' + result.id).json(result);
  };
}

/** Share the query parser and response contract across workspace compositions. */
function listIdeas(service: Pick<WorkspaceService, 'ideas'>): Handler {
  return async (request, response, principal) => {
    sendReadDto(response, await service.ideas(principal, input(listQuery, request.query)));
  };
}

// The full workspace router is installed only by isolated contract harnesses.
export function workspaceRoutes(service: WorkspaceRouteOperations, authenticate: Authenticate): Router {
  const router = Router();
  router.use(attachRequestContext);
  const withAuthenticatedRequest = (action: Handler) => authenticatedRequest(authenticate, action);
  router.get('/ideas', withAuthenticatedRequest(listIdeas(service)));
  router.post('/ideas', withAuthenticatedRequest(createIdea(service)));
  router.get('/ideas/:ideaId', withAuthenticatedRequest(async (req, res, p) => {
    input(emptyQuery, req.query);
    const result = await service.idea(p, input(uuid, req.params['ideaId']));
    sendReadDto(res.set('ETag', etag(result.version)), result);
  }));
  // The ETag identifies the version last read. If-Match carries that version
  // back on a write so the service can reject a stale update.
  router.patch('/ideas/:ideaId', withAuthenticatedRequest(patchIdea(service, ideaPatch)));
  router.get('/ideas/:ideaId/conversations', withAuthenticatedRequest(async (req, res, p) => {
    sendReadDto(res, await service.conversations(p, input(uuid, req.params['ideaId']), input(listQuery, req.query)));
  }));
  router.post('/ideas/:ideaId/conversations', withAuthenticatedRequest(async (req, res, p) => {
    input(emptyQuery, req.query);
    const id = input(uuid, req.params['ideaId']);
    await parseRequestBody(req, res);
    res.status(201).json(await service.createConversation(p, id, input(conversationCreate, req.body)));
  }));
  router.get('/conversations/:conversationId', withAuthenticatedRequest(async (req, res, p) => {
    input(emptyQuery, req.query);
    sendReadDto(res, await service.conversation(p, input(uuid, req.params['conversationId'])));
  }));
  router.patch('/me/preferences', withAuthenticatedRequest(async (req, res, p) => {
    input(emptyQuery, req.query);
    const match = ifMatch(readSingleHeader(req, 'if-match'));
    await parseRequestBody(req, res);
    const result = await service.preferences(p, match, input(preferencesPatch, req.body));
    res.set('ETag', etag(result.preferencesVersion)).json(result);
  }));
  return router;
}
