// Defines workspace DTOs, request validation, version headers and signed cursors.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export class WorkspaceError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new WorkspaceError(400, 'VALIDATION_ERROR');
  return result.data;
}
export function output<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new WorkspaceError(503, 'PROJECTION_UNAVAILABLE');
  return result.data;
}
export const uuid = z.uuid();
// PostgreSQL rejects NUL. A lone surrogate (half of a UTF-16 pair) cannot be
// encoded as UTF-8 without changing the text, so reject it before persistence.
const storageText = z.string().refine(value => value.isWellFormed() && !value.includes('\0'));
function boundedText(maxCodePoints: number) {
  // The string iterator counts Unicode code points. String.length counts UTF-16
  // units, so a character such as an emoji can count as two with String.length.
  return storageText.refine(value => Array.from(value).length <= maxCodePoints).meta({ maxLength: maxCodePoints });
}
const title = boundedText(200);
const ideaTitle = title.refine(value => value.trim().length > 0);
const ideaSummary = boundedText(5000);
export const ideaCreate = z.strictObject({ title: ideaTitle, summary: ideaSummary.optional() });
export const ideaPatch = z.strictObject({ title: title.optional(), summary: storageText.nullable().optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional() });
export const ideaDetailsPatch = z.strictObject({
  title: ideaTitle.optional(), summary: ideaSummary.nullable().optional()
}).refine(value => value.title !== undefined || value.summary !== undefined).meta({ minProperties: 1 });
export const conversationCreate = z.strictObject({ title: title.optional(), proactiveResearch: z.boolean().optional() });
export const preferencesPatch = z.strictObject({ language: z.enum(['en', 'hinglish']).optional(), researchEnabled: z.boolean().optional() });
export const idempotencyKey = z.string().min(8).max(128);
export const emptyQuery = z.strictObject({});
export const listQuery = z.strictObject({
  limit: z.string().regex(/^[0-9]+$/).transform(Number).pipe(z.number().int().min(1).max(100)).optional(),
  cursor: z.string().max(1024).optional()
});
const version = z.number().int().min(1);
export const ideaDto = z.strictObject({ id: uuid, title, summary: z.string().nullable().optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED', 'DELETION_REQUESTED', 'PURGING', 'DELETED']),
  version, createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() });
export const conversationDto = z.strictObject({ id: uuid, ideaId: uuid, title: title.nullable().optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED']), proactiveResearch: z.boolean(), version, createdAt: z.iso.datetime().optional() });
export const accountDto = z.strictObject({ id: uuid, status: z.enum(['ACTIVE', 'DISABLED', 'DELETION_REQUESTED', 'PURGING', 'DELETED']),
  preferences: z.record(z.string(), z.unknown()), preferencesVersion: version, createdAt: z.iso.datetime() });
export const etag = (v: number) => '"v' + v + '"';
export function ifMatch(value: unknown, allowZero = false): string {
  if (value === undefined) throw new WorkspaceError(428, 'PRECONDITION_REQUIRED');
  return input(z.string().regex(allowZero ? /^"v[0-9]+"$/ : /^"v[1-9][0-9]*"$/), value);
}
const anchor = z.strictObject({ id: uuid, updatedAt: z.iso.datetime() });
export class WorkspaceCursor {
  private readonly secret: Buffer;
  constructor(secret: Buffer) {
    if (secret.length < 32) throw new Error('Workspace cursor key is unavailable.');
    this.secret = Buffer.from(secret);
  }
  private sign(scope: string, value: string) {
    return createHmac('sha256', this.secret).update(JSON.stringify([scope, value])).digest();
  }
  encode(scope: string, row: { id: string; updatedAt: Date }): string {
    const value = Buffer.from(JSON.stringify({ id: row.id, updatedAt: row.updatedAt.toISOString() })).toString('base64url');
    return value + '.' + this.sign(scope, value).toString('base64url');
  }
  decode(scope: string, cursor: string | undefined) {
    if (cursor === undefined) return undefined;
    try {
      const [value, signature, extra] = cursor.split('.');
      if (!value || !signature || extra !== undefined || !/^[\w-]+$/.test(value) || !/^[\w-]{43}$/.test(signature)) throw new Error();
      const bytes = Buffer.from(signature, 'base64url');
      if (bytes.length !== 32 || bytes.toString('base64url') !== signature || !timingSafeEqual(bytes, this.sign(scope, value))) throw new Error();
      const parsed = anchor.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
      return { id: parsed.id, updatedAt: new Date(parsed.updatedAt) };
    } catch { throw new WorkspaceError(400, 'VALIDATION_ERROR'); }
  }
}
