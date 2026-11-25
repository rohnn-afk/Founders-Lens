// Coordinates authorization, workspace commands, replay and response projection.
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';
import { authorizeIdea, type IdeaAccess } from '../security/authorization.js';
import { SecurityError } from '../security/errors.js';
import type { Principal } from '../security/principal.js';
import { requireClearance, type SuppressionAuthority } from '../security/suppression-authority.js';
import { unavailableSuppressionAuthority } from '../security/suppression-unavailable.js';
import { accountDto, conversationDto, etag, ideaDto, output, uuid, WorkspaceCursor, WorkspaceError,
  type ideaCreate, type ideaPatch, type conversationCreate, type preferencesPatch, type listQuery } from './contracts.js';
import { type IdeaRow, type ConversationRow, type WorkspaceReceipt, WorkspaceRepository } from './repository.js';

type List = z.infer<typeof listQuery>;

const projectIdea = (row: IdeaRow) => output(ideaDto, { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
function projectConversation(row: ConversationRow) {
  return output(conversationDto, { id: row.id, ideaId: row.ideaId, title: row.title, status: row.status,
    proactiveResearch: row.proactiveResearch, version: row.metadataVersion, createdAt: row.createdAt.toISOString() });
}
const receipt = z.strictObject({ id: uuid, createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  version: z.literal(1), status: z.literal('ACTIVE') });

function readActiveReceipt(record: WorkspaceReceipt | null) {
  if (!record || record.expiresAt <= new Date()) return undefined;
  if (record.algorithmVersion !== 1 || record.responseStatus !== 201 || record.status !== 'SUCCEEDED') {
    throw new SecurityError('DEPENDENCY_UNAVAILABLE');
  }
  return { dto: output(receipt, record.responseRef), fingerprint: record.requestFingerprint };
}

export class WorkspaceService {
  constructor(private readonly repo: WorkspaceRepository, private readonly cursor: WorkspaceCursor,
    private readonly authority: SuppressionAuthority = unavailableSuppressionAuthority()) {}

  private async requireAccountClearance(principal: Principal, authority = this.authority) {
    if (principal.accountStatus !== 'ACTIVE') throw new SecurityError('ACCOUNT_UNAVAILABLE');
    if (principal.subjectKeys.length === 0) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
    for (const key of principal.subjectKeys) await requireClearance(authority, { kind: 'ACCOUNT',
      instanceId: principal.clerkInstanceId, subjectKeyVersion: key.version, subjectKey: key.digest, incarnation: 'ALL' });
  }
  private async authorizeIdeaAccess(principal: Principal, id: string, access: IdeaAccess, authority = this.authority) {
    // Clear the account before querying owner-scoped metadata. The idea gate
    // then obtains fresh evidence before the transaction reads private fields.
    await this.requireAccountClearance(principal, authority);
    const metadata = await this.repo.ideaMetadata(principal, id);
    await authorizeIdea(principal, metadata, authority, access);
  }
  private async writeWindow(verifyWrite?: () => Promise<number>) {
    let validUntil = verifyWrite ? await verifyWrite() : Infinity;
    const authority: SuppressionAuthority = { lookup: async (scope, request) => {
      const evidence = await this.authority.lookup(scope, request);
      if (evidence) validUntil = Math.min(validUntil, evidence.validUntil);
      return evidence;
    } };
    const requireFresh = () => {
      if (Date.now() >= validUntil) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
    };
    const verifyAfterCommit = async () => {
      if (verifyWrite) await verifyWrite();
      requireFresh();
    };
    return { authority, requireFresh, verifyAfterCommit };
  }
  private cursorScope(principal: Principal, parent?: string) {
    // A cursor marks where to resume a sorted list. Bind it to the caller,
    // optional parent idea, and sort order so it cannot cross those boundaries.
    return JSON.stringify([principal.clerkInstanceId, principal.localUserId, parent ?? null, 'updatedAt-desc/id-desc']);
  }
  private projectPage<T extends { id: string; updatedAt: Date }, U>(rows: T[], limit: number, scope: string, project: (row: T) => U) {
    const selected = rows.slice(0, limit), last = selected.at(-1), hasMore = rows.length > limit;
    const result = { items: selected.map(project), page: { hasMore, nextCursor: hasMore && last ? this.cursor.encode(scope, last) : null } };
    if (Buffer.byteLength(JSON.stringify(result)) > 4 * 1024 * 1024) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
    return result;
  }
  /** List one owner-scoped page, rejecting the entire response if any clearance expires. */
  async ideas(principal: Principal, query: List, verifyBeforeResponse?: () => Promise<void>) {
    let validUntil = Infinity;
    // Keep the earliest deadline from the evidence that the existing policy
    // validates. This wrapper never supplies or caches clearance.
    const requestAuthority: SuppressionAuthority = { lookup: async (scope, request) => {
      const evidence = await this.authority.lookup(scope, request);
      if (evidence) validUntil = Math.min(validUntil, evidence.validUntil);
      return evidence;
    } };
    const requireCurrentEvidence = () => {
      if (Date.now() >= validUntil) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
    };
    await this.requireAccountClearance(principal, requestAuthority);
    const scope = this.cursorScope(principal), limit = query.limit ?? 25;
    const candidates = await this.repo.ideaPageMetadata(principal, this.cursor.decode(scope, query.cursor), limit + 1);
    for (const item of candidates.slice(0, limit)) await authorizeIdea(principal, item, requestAuthority, 'read');
    const page = await this.repo.transaction(principal, async tx => {
      requireCurrentEvidence();
      const rows = [];
      for (const candidate of candidates.slice(0, limit)) {
        // Clearance applies to the candidates just checked. If a row changed
        // before we locked it, fail closed instead of returning a changed page.
        const row = await tx.idea(principal, candidate.id, 'read', requireCurrentEvidence);
        requireCurrentEvidence();
        if (row.updatedAt.getTime() !== candidate.updatedAt.getTime()) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
        rows.push(row);
      }
      const result = this.projectPage(rows, limit, scope, projectIdea);
      const last = rows.at(-1);
      if (last && candidates.length > limit) return { ...result, page: { hasMore: true, nextCursor: this.cursor.encode(scope, last) } };
      return result;
    });
    requireCurrentEvidence();
    if (verifyBeforeResponse) {
      // Recovery verification performs I/O outside the transaction. Its wait
      // must not let the page outlive the account and idea clearance used to read it.
      await verifyBeforeResponse();
      requireCurrentEvidence();
    }
    return page;
  }
  async idea(principal: Principal, id: string, localGuard?: () => void) {
    const access = localGuard ? 'write' : 'read';
    await this.authorizeIdeaAccess(principal, id, access);
    return this.repo.transaction(principal, async tx => projectIdea(await tx.idea(principal, id, access, localGuard)));
  }
  /** Create or replay under the account lock, with authority I/O outside primary transactions. */
  async createIdea(principal: Principal, key: string, body: z.infer<typeof ideaCreate>, verifyWrite?: () => Promise<number>) {
    const { authority, requireFresh, verifyAfterCommit } = await this.writeWindow(verifyWrite);
    const finish = async <T>(result: T): Promise<T> => {
      // Failure here may follow commit. Keep the key replayable under the existing 503 contract.
      await verifyAfterCommit();
      return result;
    };
    await this.requireAccountClearance(principal, authority);
    const targetScope = 'ideas', operationType = 'postIdeas';
    const fingerprint = createHash('sha256').update(JSON.stringify([operationType, body.title, body.summary ?? null])).digest('hex');
    const lookup = { accountId: principal.localUserId, operationType, targetScope, key };
    // An idempotency receipt ties a retry key to one committed result. Determine its scope before
    // calling the suppression authority, which must run outside database locks.
    let replay = await this.repo.transaction(principal, async tx => {
      requireFresh();
      return readActiveReceipt(await tx.ledger(lookup));
    });
    if (!replay) {
      const id = randomUUID();
      await requireClearance(authority, { kind: 'IDEA', instanceId: principal.clerkInstanceId,
        accountId: principal.localUserId, ideaId: id });
      const result = await this.repo.transaction(principal, async tx => {
        // Another same-key request may have committed during the authority call.
        // The account lock serializes this check with idea and receipt creation.
        const previous = await tx.ledger(lookup);
        const concurrent = readActiveReceipt(previous);
        requireFresh();
        if (concurrent) return { replay: concurrent };
        const row = await tx.createIdea({ id, ownerId: principal.localUserId, title: body.title, summary: body.summary ?? null });
        const dto = projectIdea(row);
        const responseRef = output(receipt, { id, createdAt: dto.createdAt, updatedAt: dto.updatedAt, version: dto.version, status: dto.status });
        await tx.saveReceipt(lookup, previous?.id, { requestFingerprint: fingerprint, responseRef,
          status: 'SUCCEEDED', responseStatus: 201, expiresAt: new Date(Date.now() + 14 * 86400_000) });
        requireFresh();
        return { created: dto };
      });
      if (result.created) return finish(result.created);
      replay = result.replay;
    }
    const originalId = replay.dto.id;
    await this.authorizeIdeaAccess(principal, originalId, 'read', authority);
    const result = await this.repo.transaction(principal, async tx => {
      const current = readActiveReceipt(await tx.ledger(lookup));
      if (!current || current.dto.id !== originalId) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
      await tx.idea(principal, originalId, 'read', requireFresh);
      requireFresh();
      if (current.fingerprint !== fingerprint) throw new WorkspaceError(409, 'IDEMPOTENCY_KEY_REUSED');
      // Rebuild the original text from the matched retry without storing a copy
      // in the receipt or substituting text from the current idea.
      return output(ideaDto, { ...current.dto, title: body.title, summary: body.summary ?? null });
    });
    return finish(result);
  }
  async patchIdea(principal: Principal, id: string, match: string, patch: z.infer<typeof ideaPatch>,
    verifyWrite?: () => Promise<number>) {
    const { authority, requireFresh, verifyAfterCommit } = await this.writeWindow(verifyWrite);
    await this.authorizeIdeaAccess(principal, id, 'write', authority);
    const result = await this.repo.transaction(principal, async tx => {
      const row = await tx.idea(principal, id, 'write', requireFresh);
      // Optimistic concurrency compares the caller's version with the locked
      // row so a stale client cannot silently overwrite a more recent edit.
      if (etag(row.version) !== match) throw new WorkspaceError(412, 'PRECONDITION_FAILED');
      requireFresh();
      const idea = projectIdea(await tx.updateIdea(id, row.version,
        { version: { increment: 1 }, ...(patch.title === undefined ? {} : { title: patch.title }),
          ...(patch.summary === undefined ? {} : { summary: patch.summary }), ...(patch.status === undefined ? {} : { status: patch.status }) }));
      requireFresh();
      return idea;
    });
    await verifyAfterCommit();
    return result;
  }
  async conversations(principal: Principal, id: string, query: List, localGuard?: () => void) {
    const access = localGuard ? 'write' : 'read';
    await this.authorizeIdeaAccess(principal, id, access);
    const scope = this.cursorScope(principal, id), limit = query.limit ?? 25;
    const anchor = this.cursor.decode(scope, query.cursor);
    return this.repo.transaction(principal, async tx => {
      await tx.idea(principal, id, access, localGuard);
      const rows = await tx.conversations(id, anchor, limit + 1, Boolean(localGuard));
      return this.projectPage(rows, limit, scope, projectConversation);
    });
  }
  async createConversation(principal: Principal, id: string, body: z.infer<typeof conversationCreate>, localGuard?: () => void) {
    // This POST has no idempotency receipt. If the reply is lost, the caller
    // reconciles by listing conversations before deciding whether to create again.
    await this.authorizeIdeaAccess(principal, id, 'write');
    return this.repo.transaction(principal, async tx => {
      await tx.idea(principal, id, 'write', localGuard);
      localGuard?.();
      const row = await tx.createConversation({ ideaId: id, title: body.title ?? null,
        ...(body.proactiveResearch === undefined ? {} : { proactiveResearch: body.proactiveResearch }) });
      localGuard?.();
      return projectConversation(row);
    });
  }
  async conversation(principal: Principal, id: string, localGuard?: () => void) {
    await this.requireAccountClearance(principal);
    const child = await this.repo.conversationParent(principal, id);
    if (!child) throw new SecurityError('RESOURCE_NOT_FOUND');
    const access = localGuard ? 'write' : 'read';
    await this.authorizeIdeaAccess(principal, child.ideaId, access);
    return this.repo.transaction(principal, async tx => {
      await tx.idea(principal, child.ideaId, access, localGuard);
      const row = await tx.conversation(id, child.ideaId);
      if (!row || (localGuard && row.status !== 'ACTIVE')) throw new SecurityError('RESOURCE_NOT_FOUND');
      return projectConversation(row);
    });
  }
  async preferences(principal: Principal, match: string, patch: z.infer<typeof preferencesPatch>) {
    await this.requireAccountClearance(principal);
    return this.repo.transaction(principal, async tx => {
      const account = await tx.account(principal.localUserId);
      if (etag(account.preferencesVersion) !== match) throw new WorkspaceError(412, 'PRECONDITION_FAILED');
      if (!account.preferences || typeof account.preferences !== 'object' || Array.isArray(account.preferences)) {
        throw new WorkspaceError(503, 'PROJECTION_UNAVAILABLE');
      }
      const preferences: Prisma.InputJsonObject = { ...account.preferences,
        ...(patch.language === undefined ? {} : { language: patch.language }),
        ...(patch.researchEnabled === undefined ? {} : { researchEnabled: patch.researchEnabled }) };
      const row = await tx.updatePreferences(account.id, account.preferencesVersion, preferences);
      return output(accountDto, { ...row, createdAt: row.createdAt.toISOString() });
    });
  }
}
