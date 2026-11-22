// Local save-only admission. The transaction can write only a USER turn,
// its sequence, and its receipt. Generation admission is a separate command.
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../generated/prisma/client.js';
import { lockWorkspaceAccount } from '../persistence/workspace-transaction.js';
import { authorizeChild } from '../security/authorization.js';
import { SecurityError } from '../security/errors.js';
import type { Principal } from '../security/principal.js';
import { requireClearance, type SuppressionAuthority } from '../security/suppression-authority.js';
import { lockIdea } from '../workspace/repository.js';
import { digest, fingerprintVersion, messageDto, requestFingerprint, storedMessageText, SubmissionError, type MessageCreate } from './contracts.js';
import type { SubmissionRepository } from './service.js';

const operation = 'saveConversationUserMessage';
const receiptLifetime = 14 * 86400_000;

/** Clear the exact parent scope, then lock account, idea and conversation before writing. */
export async function saveUserMessage(client: PrismaClient, scopes: Pick<SubmissionRepository, 'scope'>,
  authority: SuppressionAuthority, principal: Principal, conversationId: string, key: string, body: MessageCreate,
  requireFresh: () => void) {
  if (principal.accountStatus !== 'ACTIVE') throw new SecurityError('ACCOUNT_UNAVAILABLE');
  if (principal.subjectKeys.length === 0) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
  for (const subjectKey of principal.subjectKeys) await requireClearance(authority, { kind: 'ACCOUNT',
    instanceId: principal.clerkInstanceId, subjectKeyVersion: subjectKey.version, subjectKey: subjectKey.digest, incarnation: 'ALL' });
  const scope = await scopes.scope(principal, conversationId);
  if (!scope || scope.id !== conversationId || scope.status !== 'ACTIVE') throw new SecurityError('RESOURCE_NOT_FOUND');
  await authorizeChild(principal, scope.idea, scope, authority, 'write');
  const fingerprint = requestFingerprint(body, operation);
  const receiptKey = { accountId: principal.localUserId, operationType: operation, targetScope: conversationId, key };
  const contentHash = digest(body.content);
  return client.$transaction(async tx => {
    await lockWorkspaceAccount(tx, principal);
    await lockIdea(tx, principal, scope.ideaId, 'write', requireFresh);
    const [conversation] = await tx.$queryRaw<{ nextSequence: number }[]>`
      SELECT "nextSequence" FROM "Conversation" WHERE id=${conversationId}::uuid AND "ideaId"=${scope.ideaId}::uuid
        AND status='ACTIVE' FOR UPDATE`;
    if (!conversation) throw new SecurityError('RESOURCE_NOT_FOUND');
    requireFresh();
    const receipt = await tx.idempotencyRecord.findUnique({ where: { accountId_operationType_targetScope_key: receiptKey },
      select: { algorithmVersion: true, requestFingerprint: true, responseRef: true, responseStatus: true, status: true } });
    requireFresh();
    if (receipt && receipt.requestFingerprint !== fingerprint) throw new SubmissionError('IDEMPOTENCY_KEY_REUSED');
    const existing = await tx.message.findUnique({ where: { conversationId_clientSubmissionKey: {
      conversationId, clientSubmissionKey: body.clientSubmissionId
    } }, select: { id: true, ideaId: true, conversationId: true, sequence: true, role: true, content: true,
      contentSchemaVersion: true, submissionSha256: true, createdAt: true } });
    requireFresh();
    if (receipt) {
      const ref = receipt.responseRef as { messageId?: unknown } | null;
      const text = storedMessageText.safeParse(existing?.content);
      if (!existing || ref?.messageId !== existing.id || existing.ideaId !== scope.ideaId ||
        existing.role !== 'USER' || existing.contentSchemaVersion !== 1 || existing.submissionSha256 !== contentHash ||
        !text.success || text.data.text !== body.content || receipt.algorithmVersion !== fingerprintVersion ||
        receipt.responseStatus !== 201 || receipt.status !== 'SUCCEEDED') throw new SecurityError('DEPENDENCY_UNAVAILABLE');
      return messageDto.parse({ id: existing.id, conversationId, sequence: existing.sequence, role: 'USER',
        content: text.data.text, createdAt: existing.createdAt.toISOString() });
    }
    // A USER turn from another command or a pruned receipt must never be duplicated.
    if (existing) throw new SubmissionError('IDEMPOTENCY_KEY_REUSED');
    const sequence = conversation.nextSequence;
    if (!Number.isInteger(sequence) || sequence < 1 || sequence >= 2147483647) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
    const id = randomUUID(), now = new Date();
    await tx.$executeRaw`UPDATE "Conversation" SET "nextSequence"=${sequence + 1}, "updatedAt"=${now}
      WHERE id=${conversationId}::uuid AND "ideaId"=${scope.ideaId}::uuid`;
    requireFresh();
    await tx.$executeRaw`INSERT INTO "Message" (id,"ideaId","conversationId",sequence,role,content,"clientSubmissionKey","submissionSha256","createdAt")
      VALUES (${id}::uuid,${scope.ideaId}::uuid,${conversationId}::uuid,${sequence},'USER',${JSON.stringify({ text: body.content })}::jsonb,
        ${body.clientSubmissionId},${contentHash},${now})`;
    await tx.idempotencyRecord.create({ data: { ...receiptKey, requestFingerprint: fingerprint, algorithmVersion: fingerprintVersion,
      status: 'SUCCEEDED', responseStatus: 201, responseRef: { messageId: id }, createdAt: now,
      expiresAt: new Date(now.getTime() + receiptLifetime) }, select: { id: true } });
    requireFresh();
    return messageDto.parse({ id, conversationId, sequence, role: 'USER', content: body.content, createdAt: now.toISOString() });
  });
}
