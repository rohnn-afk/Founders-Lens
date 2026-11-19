// Isolated HTTP adapter for submission. The caller injects verified identity
// and a service; this factory is never mounted by the application shell.
import { json, Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { bearerToken } from '../security/bearer.js';
import { SecurityError, securityFailure } from '../security/errors.js';
import type { Principal } from '../security/principal.js';
import { attachRequestContext, requestContext } from '../security/request-context.js';
import { acceptance, keySchema, messageCreate, SubmissionError, uuid } from './contracts.js';
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

export function submissionRoutes(service: SubmissionService, authenticate: (request: Request) => Promise<Principal | null>) {
  const router = Router();
  router.use(attachRequestContext);
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
      response.status(failure.status).json(failure.body);
    }
  });
  return router;
}
