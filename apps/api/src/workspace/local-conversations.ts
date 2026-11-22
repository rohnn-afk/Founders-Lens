// P8 service composition. Each operation carries the shortest observed
// clearance deadline into its local transaction and through response release.
import type { PrismaClient } from '../generated/prisma/client.js';
import { SecurityError } from '../security/errors.js';
import type { SuppressionAuthority } from '../security/suppression-authority.js';
import { SubmissionError } from '../submission/contracts.js';
import { createSubmissionRepository } from '../submission/repository.js';
import { saveUserMessage } from '../submission/save-user-message.js';
import { createSubmissionService } from '../submission/service.js';
import { WorkspaceCursor } from './contracts.js';
import { WorkspaceRepository } from './repository.js';
import type { LocalConversationOperations } from './routes.js';
import { WorkspaceService } from './service.js';

type VerifyDeadline = () => Promise<number>;

/** Supply separate verified permissions to the existing conversation and transcript services. */
export function localConversationOperations(client: PrismaClient, authority: SuppressionAuthority, cursorSecret: Buffer,
  permissions: { read: VerifyDeadline; create?: VerifyDeadline; save?: VerifyDeadline }): LocalConversationOperations {
  const workspaceRepository = new WorkspaceRepository(client);
  const submissionRepository = createSubmissionRepository(client);
  const cursor = new WorkspaceCursor(cursorSecret);

  async function withClearance<T>(verify: VerifyDeadline,
    action: (scopedAuthority: SuppressionAuthority, requireFresh: () => void) => Promise<T>) {
    let deadline = await verify();
    const requireFresh = () => {
      if (Date.now() >= deadline) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
    };
    const scopedAuthority: SuppressionAuthority = { async lookup(scope, request) {
      const evidence = await authority.lookup(scope, request);
      if (evidence) deadline = Math.min(deadline, evidence.validUntil);
      return evidence;
    } };
    async function verifyResponse() {
      requireFresh();
      // A write may already have committed. A later denial is an uncertain result.
      deadline = Math.min(deadline, await verify());
      requireFresh();
    }
    let result: T;
    try { result = await action(scopedAuthority, requireFresh); }
    catch (error) {
      // A conflict reveals the existence of an earlier intent in this scope.
      if (error instanceof SubmissionError && error.code === 'IDEMPOTENCY_KEY_REUSED') await verifyResponse();
      throw error;
    }
    await verifyResponse();
    return result;
  }
  const workspace = (scoped: SuppressionAuthority) => new WorkspaceService(workspaceRepository, cursor, scoped);
  const { read, create, save } = permissions;
  return {
    idea: (principal, id) => withClearance(read, (scoped, fresh) => workspace(scoped).idea(principal, id, fresh)),
    conversations: (principal, id, query) => withClearance(read, (scoped, fresh) => workspace(scoped).conversations(principal, id, query, fresh)),
    conversation: (principal, id) => withClearance(read, (scoped, fresh) => workspace(scoped).conversation(principal, id, fresh)),
    history: (principal, id, query) => withClearance(read, (scoped, fresh) => createSubmissionService(submissionRepository, scoped,
      { clock: () => new Date(), cursorSecret }).history(principal, id, query, fresh)),
    ...(create && { create: (principal, id, body) => withClearance(create,
      (scoped, fresh) => workspace(scoped).createConversation(principal, id, body, fresh)) }),
    ...(save && { save: (principal, id, key, body) => withClearance(save,
      (scoped, fresh) => saveUserMessage(client, submissionRepository, scoped, principal, id, key, body, fresh)) })
  };
}
