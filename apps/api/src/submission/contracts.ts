// HTTP and persistence contracts for message acceptance. The router validates
// inputs here and the repository reconstructs the same response on replay.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const uuid = z.uuid();
export const keySchema = z.string().min(8).max(128);
export const messageCreate = z.strictObject({
  clientSubmissionId: uuid,
  content: z.string().refine(value => {
    // Count Unicode code points and preserve accepted text exactly. PostgreSQL
    // cannot store NUL, and encoding a lone surrogate would change the text.
    if (!value.isWellFormed() || value.includes('\0')) return false;
    const length = Array.from(value).length;
    return length >= 1 && length <= 10_000;
  })
});
export const acceptanceRef = z.strictObject({ messageId: uuid, generationId: uuid });
export type MessageCreate = z.infer<typeof messageCreate>;
export type AcceptanceRef = z.infer<typeof acceptanceRef>;

export function acceptance(ref: AcceptanceRef) {
  const statusUrl = '/api/v1/generations/' + ref.generationId;
  return { ...ref, status: 'PENDING' as const, statusUrl, eventsUrl: statusUrl + '/events' };
}

export const submissionOperation = 'postConversationsConversationIdMessages';
export const fingerprintVersion = 1;

// A fingerprint hashes the meaningful request fields in a fixed order.
// The receipt stores this digest and safe IDs instead of copying the message.
export function requestFingerprint(body: MessageCreate) {
  return digest(JSON.stringify([submissionOperation, body.clientSubmissionId, body.content]));
}

export function digest(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export const transcriptQuery = z.strictObject({
  limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(100)).optional(),
  cursor: z.string().min(1).max(256).optional(),
  assistantResponseVersion: z.enum(['1', '2']).optional()
});
export type TranscriptQuery = z.infer<typeof transcriptQuery>;
const turnAnchor = z.tuple([z.number().int().min(1).max(2147483647), z.union([z.literal(0), z.literal(1)])]);
export type TurnAnchor = z.infer<typeof turnAnchor>;
export const messageDto = z.strictObject({
  id: uuid, conversationId: uuid, sequence: z.number().int().positive(),
  role: z.enum(['USER', 'ASSISTANT']), content: z.string(), createdAt: z.iso.datetime()
});
export const storedMessageText = z.object({ text: z.string() });

// The signature binds the logical turn position to this owner, parent and
// query. A cursor copied from another conversation cannot move this read.
export function transcriptCursor(secret: Buffer) {
  if (secret.length < 32) throw new Error('Transcript cursor key is unavailable.');
  const key = Buffer.from(secret);
  const sign = (scope: string, value: string) =>
    createHmac('sha256', key).update(JSON.stringify(['transcript-v1', scope, value])).digest();
  return {
    encode(scope: string, anchor: TurnAnchor) {
      const value = Buffer.from(JSON.stringify(anchor)).toString('base64url');
      return value + '.' + sign(scope, value).toString('base64url');
    },
    decode(scope: string, cursor: string): TurnAnchor {
      const [value, signature, extra] = cursor.split('.');
      if (!value || !signature || extra !== undefined || !/^[\w-]+$/.test(value) || !/^[\w-]{43}$/.test(signature)) {
        throw new SubmissionError('VALIDATION_ERROR');
      }
      const bytes = Buffer.from(signature, 'base64url');
      if (bytes.toString('base64url') !== signature || !timingSafeEqual(bytes, sign(scope, value))) {
        throw new SubmissionError('VALIDATION_ERROR');
      }
      try { return turnAnchor.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))); }
      catch { throw new SubmissionError('VALIDATION_ERROR'); }
    }
  };
}

const failures = {
  VALIDATION_ERROR: [400, 'Invalid message submission.'],
  IDEMPOTENCY_KEY_REUSED: [409, 'The idempotency key was used for a different request.'],
  CONFLICT: [409, 'The submission ID was used for different content.'],
  GENERATION_IN_PROGRESS: [409, 'A generation is already in progress.'],
  PAYLOAD_TOO_LARGE: [413, 'The request body is too large.'],
  UNSUPPORTED_MEDIA_TYPE: [415, 'The request must contain JSON.'],
  QUOTA_EXCEEDED: [429, 'The submission quota is exhausted.'],
  NOT_FOUND: [404, 'The requested resource was not found.'],
  PROJECTION_UNAVAILABLE: [503, 'The workspace request could not be completed.']
} as const;

export class SubmissionError extends Error {
  constructor(readonly code: keyof typeof failures) {
    super(failures[code][1]);
  }

  failure(requestId: string) {
    return { status: failures[this.code][0], body: { error: {
      code: this.code, message: this.message, requestId, retryable: this.code === 'PROJECTION_UNAVAILABLE'
    } } };
  }
}
