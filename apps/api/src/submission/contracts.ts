// HTTP and persistence contracts for message acceptance. The router validates
// inputs here and the repository reconstructs the same response on replay.
import { createHash } from 'node:crypto';
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

const failures = {
  VALIDATION_ERROR: [400, 'Invalid message submission.'],
  IDEMPOTENCY_KEY_REUSED: [409, 'The idempotency key was used for a different request.'],
  CONFLICT: [409, 'The submission ID was used for different content.'],
  GENERATION_IN_PROGRESS: [409, 'A generation is already in progress.'],
  PAYLOAD_TOO_LARGE: [413, 'The request body is too large.'],
  UNSUPPORTED_MEDIA_TYPE: [415, 'The request must contain JSON.'],
  QUOTA_EXCEEDED: [429, 'The submission quota is exhausted.']
} as const;

export class SubmissionError extends Error {
  constructor(readonly code: keyof typeof failures) {
    super(failures[code][1]);
  }

  failure(requestId: string) {
    return { status: failures[this.code][0], body: { error: {
      code: this.code, message: this.message, requestId, retryable: false
    } } };
  }
}
