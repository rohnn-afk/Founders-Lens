// Isolated HTTP adapter for submission. The caller injects verified identity
// and a service; this factory is never mounted by the application shell.
import { json, Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { bearerToken } from '../security/bearer.js';
import { SecurityError, securityFailure } from '../security/errors.js';
import type { Principal } from '../security/principal.js';
import { attachRequestContext, requestContext, traceSubmissionFailure } from '../security/request-context.js';
import { acceptance, keySchema, messageCreate, SubmissionError, transcriptQuery, uuid } from './contracts.js';
import type { SubmissionService } from './service.js';

// A supplementary code point can occupy 12 bytes when JSON-escaped.
const parseJson = json({ limit: '128kb' });

function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new SubmissionError('VALIDATION_ERROR');
  return result.data;
}
function readKey(request: Request) {
  const count = request.rawHeaders.filter((name, index) => index % 2 === 0 && name.toLowerCase() === 'idempotency-key').length;
  if (count !== 1) throw new SubmissionError('VALIDATION_ERROR');
  return validate(keySchema, request.get('idempotency-key'));
}
function readBody(request: Request, response: Response): Promise<void> {
  if (!request.is('application/json')) throw new SubmissionError('UNSUPPORTED_MEDIA_TYPE');
  return new Promise((resolve, reject) => parseJson(request, response, error => {
    if (!error) resolve();
    else reject(new SubmissionError(error.status === 413 ? 'PAYLOAD_TOO_LARGE'
      : error.status === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : 'VALIDATION_ERROR'));
  }));
}

export function submissionRoutes(service: SubmissionService, authenticate: (request: Request) => Promise<Principal | null>,
  { submitOnly = false, readDeadline, readConversation }: { submitOnly?: boolean; readDeadline?: () => Promise<number>;
    readConversation?: string } = {}) {
  const router = Router();
  router.use(attachRequestContext);
  const read = (action: (request: Request, principal: Principal) => Promise<unknown>) =>
    async (request: Request, response: Response, next: NextFunction) => {
      if (readConversation && request.params['conversationId'] !== readConversation) return next('router');
      response.set('Cache-Control', 'no-store');
      const { requestId } = requestContext(response);
      try {
        bearerToken(request.headers, request.rawHeaders);
        const principal = await authenticate(request);
        if (!principal) throw new SecurityError('UNAUTHENTICATED');
        if (request.get('transfer-encoding') || Number(request.get('content-length') ?? 0) > 0) {
          throw new SubmissionError('VALIDATION_ERROR');
        }
        const deadline = await readDeadline?.();
        const dto = await action(request, principal);
        if (deadline !== undefined && Date.now() >= deadline) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
        response.status(200).type('application/json').end(JSON.stringify(dto));
      } catch (error) {
        const mapped = error instanceof SecurityError && error.code === 'RESOURCE_NOT_FOUND'
          ? new SubmissionError('NOT_FOUND') : error;
        const failure = mapped instanceof SubmissionError ? mapped.failure(requestId) : securityFailure(mapped, requestId);
        response.status(failure.status).json(failure.body);
      }
    };
  if (!submitOnly) router.get('/conversations/:conversationId/submissions/:clientSubmissionId', read(async (request, principal) => {
    if (Object.keys(request.query).length) throw new SubmissionError('VALIDATION_ERROR');
    const conversationId = validate(uuid, request.params['conversationId']);
    const clientSubmissionId = validate(uuid, request.params['clientSubmissionId']);
    const { messageId, generationId } = await service.correlate(principal, conversationId, clientSubmissionId);
    const { statusUrl, eventsUrl } = acceptance({ messageId, generationId });
    return { clientSubmissionId, messageId, generationId, statusUrl, eventsUrl };
  }));
  if (!submitOnly) router.get('/conversations/:conversationId/messages', read((request, principal) =>
    service.history(principal, validate(uuid, request.params['conversationId']), validate(transcriptQuery, request.query))));
  router.post('/conversations/:conversationId/messages', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    const { requestId } = requestContext(response);
    try {
      // Validate the one bearer source, then let the injected boundary verify it.
      bearerToken(request.headers, request.rawHeaders);
      const principal = await authenticate(request);
      if (!principal) throw new SecurityError('UNAUTHENTICATED');
      const conversationId = validate(uuid, request.params['conversationId']);
      const key = readKey(request);
      if (Object.keys(request.query).length) throw new SubmissionError('VALIDATION_ERROR');
      await readBody(request, response);
      const result = acceptance(await service.submit(principal, conversationId, key, validate(messageCreate, request.body)));
      response.status(202).location(result.statusUrl).json(result);
    } catch (error) {
      const failure = error instanceof SubmissionError ? error.failure(requestId) : securityFailure(error, requestId);
      const category = error instanceof SecurityError ? error.denialCategory : undefined;
      traceSubmissionFailure(response, failure.status, category ?? (failure.status === 401 ? 'UNAUTHENTICATED'
        : failure.status === 403 || failure.status === 404 ? 'ACCESS_DENIED'
          : failure.status >= 500 ? 'REQUEST_FAILED' : 'REQUEST_REJECTED'));
      response.status(failure.status).json(failure.body);
    }
  });
  return router;
}
