// Isolated Express adapter. The test composition injects verified identity and
// mounts this router explicitly; the normal application does not import it.
import { documentedRoute } from '../documentation/routes.js';
import { json, Router, type Request, type Response } from 'express';
import { bearerToken } from '../security/bearer.js';
import { SecurityError, securityFailure } from '../security/errors.js';
import type { Principal } from '../security/principal.js';
import { attachRequestContext, requestContext } from '../security/request-context.js';
import { keySchema, SubmissionError, uuid } from '../submission/contracts.js';
import { generationUrl, regeneration } from './contracts.js';
import type { GenerationService } from './service.js';

const parser = json({ limit: '2kb' });
function key(request: Request) {
  const count = request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'idempotency-key').length;
  const result = keySchema.safeParse(request.get('idempotency-key'));
  if (count !== 1 || !result.success) throw new SubmissionError('VALIDATION_ERROR');
  return result.data;
}

async function body(request: Request, response: Response) {
  if (!request.is('application/json')) throw new SubmissionError('UNSUPPORTED_MEDIA_TYPE');
  await new Promise<void>((resolve, reject) => parser(request, response, error => error
    ? reject(new SubmissionError(error.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION_ERROR')) : resolve()));
  const parsed = regeneration.safeParse(request.body);
  if (!parsed.success) throw new SubmissionError('VALIDATION_ERROR');
  return parsed.data;
}

export function generationRoutes(service: GenerationService, authenticate: (request: Request) => Promise<Principal | null>,
  { statusOnly = false }: { statusOnly?: boolean } = {}) {
  const router = Router();
  router.use(attachRequestContext);
  const handle = (kind: 'status' | 'cancel' | 'regenerate') => async (request: Request, response: Response) => {
    response.set('Cache-Control', 'no-store');
    try {
      bearerToken(request.headers, request.rawHeaders);
      const principal = await authenticate(request);
      if (!principal) throw new SecurityError('UNAUTHENTICATED');
      const target = uuid.safeParse(request.params[kind === 'regenerate' ? 'conversationId' : 'generationId']);
      if (!target.success || Object.keys(request.query).length || (kind !== 'regenerate' &&
        (request.get('transfer-encoding') || Number(request.get('content-length') ?? 0) > 0))) {
        throw new SubmissionError('VALIDATION_ERROR');
      }
      if (kind === 'status') {
        response.json(await service.status(principal, target.data));
        return;
      }
      const commandKey = key(request);
      const result = await service.command(principal, kind === 'cancel'
        ? { kind, target: target.data, key: commandKey }
        : { kind, target: target.data, key: commandKey, ...await body(request, response) });
      if (kind === 'regenerate') response.location(generationUrl(result.body.id));
      response.status(result.status).json(result.body);
    } catch (error) {
      const mapped = error instanceof SecurityError && error.code === 'RESOURCE_NOT_FOUND' ? new SubmissionError('NOT_FOUND') : error;
      const id = requestContext(response).requestId;
      const failure = mapped instanceof SubmissionError ? mapped.failure(id) : securityFailure(mapped, id);
      response.status(failure.status).json(failure.body);
    }
  };
  documentedRoute(router, 'get', '/generations/:generationId', handle('status'));
  if (!statusOnly) {
    router.post('/generations/:generationId/cancel', handle('cancel'));
    router.post('/conversations/:conversationId/regenerations', handle('regenerate'));
  }
  return router;
}
