// Wire and receipt schemas for the isolated generation HTTP operations.
import { z } from 'zod';

export const generationStatus = z.enum(['PENDING', 'RUNNING', 'CANCEL_REQUESTED', 'COMPLETED', 'FAILED', 'CANCELLED']);
export const regeneration = z.strictObject({ triggerMessageId: z.uuid() });
export const generation = z.strictObject({
  id: z.uuid(), conversationId: z.uuid(), triggerMessageId: z.uuid(), status: generationStatus,
  selected: z.boolean(), createdAt: z.iso.datetime(), outputMessageId: z.uuid().optional(),
  startedAt: z.iso.datetime().optional(), finishedAt: z.iso.datetime().optional(),
  error: z.strictObject({ code: z.string(), retryable: z.boolean() }).optional()
});
export type Generation = z.infer<typeof generation>;
export type CommandResult = { status: 200 | 202; body: Generation };
export type Command = { kind: 'cancel'; target: string; key: string }
  | { kind: 'regenerate'; target: string; key: string; triggerMessageId: string };

export function generationUrl(id: string) { return '/api/v1/generations/' + id; }
