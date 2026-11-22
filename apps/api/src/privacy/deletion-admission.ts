// Unmounted P5-AM01 use case. Current identity and ownership authorize only
// deletion admission or its minimal replay, without granting workspace access.
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { createClerkBoundary } from '../security/clerk.js';
import type { IdentityProvider } from '../security/identity-provider.js';
import type { SubjectKeys } from '../security/subject-key.js';
import { SecurityError } from '../security/errors.js';
import { suppressionScopeKey, type SuppressionScope } from '../security/suppression-authority.js';
import type { createSuppressionLedger } from '../security/suppression-ledger.js';
import type { createDeletionRepository, DeletionTarget } from './deletion-repository.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Parsed deletion command. Null idea means the authenticated caller's account. */
export interface DeletionCommand {
  readonly ideaId: string | null;
  readonly idempotencyKey: string;
  readonly policyVersion: string;
  readonly confirmed: true;
}

/** Compose a deletion-only boundary with server-owned policy and restricted stores. */
export function createDeletionAdmission(deps: {
  clerk: Pick<ReturnType<typeof createClerkBoundary>, 'authenticate' | 'verifyDeletionReverification'>;
  provider: IdentityProvider;
  subjectKeys: SubjectKeys;
  ledger: Pick<ReturnType<typeof createSuppressionLedger>, 'reserve' | 'verifyReservation' | 'assertSubjectVersions'>;
  repository: ReturnType<typeof createDeletionRepository>;
  policy: { readonly version: string; readonly requireMfa: boolean;
    readonly operationDeadlineMs: number; readonly receiptLifetimeMs: number };
}) {
  const policy = Object.freeze({ ...deps.policy });
  for (const value of [policy.operationDeadlineMs, policy.receiptLifetimeMs]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid deletion lifetime');
  }

  /** Verify identity, recover an exact committed receipt, or commit an authority-backed intent. */
  return async function admit(headers: IncomingHttpHeaders, rawHeaders: readonly string[], command: DeletionCommand) {
    try {
      if (command.confirmed !== true || !/^[\x21-\x7e]{1,128}$/.test(command.idempotencyKey) ||
        !/^[A-Za-z0-9_-]{1,60}$/.test(command.policyVersion) ||
        (command.ideaId !== null && !uuid.test(command.ideaId))) throw new SecurityError('ACCOUNT_UNAVAILABLE');
      const identity = await deps.clerk.authenticate(headers, rawHeaders);
      await deps.provider.assertLive(identity);
      const subjectKeys = deps.subjectKeys.derive(identity.instanceId, identity.subject);
      deps.ledger.assertSubjectVersions(subjectKeys.map(key => key.version));
      const { accountId, subjectKey, eligible } = await deps.repository.resolve(identity, command.ideaId, subjectKeys);
      const scope: SuppressionScope = command.ideaId ? {
        kind: 'IDEA', instanceId: identity.instanceId, accountId, ideaId: command.ideaId
      } : { kind: 'ACCOUNT', instanceId: identity.instanceId, subjectKeyVersion: subjectKey.version,
        subjectKey: subjectKey.digest, incarnation: 'ALL' };
      const scopeKey = suppressionScopeKey(scope);
      const fingerprint = createHash('sha256').update(JSON.stringify(
        ['deletion-command-v1', accountId, scopeKey, command.idempotencyKey, command.policyVersion, true]
      )).digest('hex');
      const target: DeletionTarget = { identity, accountId, ideaId: command.ideaId, subjectKeys, subjectKey,
        scopeKey, fingerprint, idempotencyKey: command.idempotencyKey, policyVersion: command.policyVersion };
      const intent = { scope, fingerprint, policyVersion: command.policyVersion };
      const receipt = await deps.repository.replay(target);
      if (receipt) {
        await deps.ledger.verifyReservation({ ...intent, operationId: receipt.operationId }, receipt.challengeKey);
        if (identity.expiresAt <= Date.now()) throw new SecurityError('UNAUTHENTICATED');
        return { status: 202 as const, operationId: receipt.operationId };
      }
      if (!eligible || policy.version !== command.policyVersion) throw new SecurityError('ACCOUNT_UNAVAILABLE');
      const evidence = await deps.clerk.verifyDeletionReverification(headers, rawHeaders, { requireMfa: policy.requireMfa });
      if (evidence.identity.instanceId !== identity.instanceId || evidence.identity.subject !== identity.subject ||
        evidence.identity.sessionId !== identity.sessionId) throw new SecurityError('UNAUTHENTICATED');
      // Authority I/O precedes the primary transaction, including the read-back after an uncertain write.
      const reservation = await deps.ledger.reserve({ ...intent, operationId: randomUUID() }, evidence);
      const now = Date.now();
      const operationId = await deps.repository.commit(target, reservation, Math.min(evidence.validUntil, identity.expiresAt),
        new Date(now + policy.operationDeadlineMs), new Date(now + policy.receiptLifetimeMs));
      return { status: 202 as const, operationId };
    } catch (error) {
      if (error instanceof SecurityError) throw error;
      throw new SecurityError('DEPENDENCY_UNAVAILABLE');
    }
  };
}
