// Unmounted restore proof. The operator controls isolation and cutoff;
// this coordinator revalidates both stores before permitting fixture reads.
import { z } from 'zod';
import type { createSuppressionLedger, RecoveryCutoff } from '../security/suppression-ledger.js';
import { suppressionScopeKey, type SuppressionScope } from '../security/suppression-authority.js';
import type { SubjectKeys } from '../security/subject-key.js';
import { SecurityError } from '../security/errors.js';
import type { createDeletionRepository } from './deletion-repository.js';

const scopeRecord = z.union([
  z.tuple([z.literal('ACCOUNT'), z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), z.number().int().positive(),
    z.string().regex(/^[0-9a-f]{64}$/), z.literal('ALL')]),
  z.tuple([z.literal('IDEA'), z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), z.uuid(), z.uuid()])
]);

/** Decode the authenticated scope tuple without accepting caller-provided tenant identifiers. */
function decodeScope(encoded: string): SuppressionScope {
  const row = scopeRecord.parse(JSON.parse(encoded));
  return row[0] === 'ACCOUNT' ? { kind: 'ACCOUNT', instanceId: row[1], subjectKeyVersion: row[2],
    subjectKey: row[3], incarnation: row[4] } : { kind: 'IDEA', instanceId: row[1], accountId: row[2], ideaId: row[3] };
}

/**
 * Compose a closed restore gate for one externally selected run and PostgreSQL target.
 * The isolation assertion must prove admissions and old worker credentials are quarantined.
 * No method authorizes a user request or starts a queue or worker.
 */
export function createDeletionRecovery(deps: {
  readonly cutoff: RecoveryCutoff;
  readonly repository: ReturnType<typeof createDeletionRepository>;
  readonly ledger: Pick<ReturnType<typeof createSuppressionLedger>,
    'recoveryInventory' | 'matchesIncarnation' | 'recordRecovery' | 'verifyRecoveryProgress' | 'assertSubjectVersions'>;
  readonly subjectKeys: SubjectKeys;
  readonly assertIsolated: () => Promise<void>;
  readonly operationDeadlineMs: number;
}) {
  const cutoff = Object.freeze({ ...deps.cutoff });
  if (!Number.isSafeInteger(deps.operationDeadlineMs) || deps.operationDeadlineMs <= 0) {
    throw new Error('Invalid recovery operation deadline');
  }
  // Object identity distinguishes two openings with the same frozen inventory.
  // A read started under the older opening must not survive a closed interval.
  let completed: { readonly digest: string } | undefined;
  let reconciling = false;

  /** Revalidate the external quarantine, exact target, and authenticated frozen snapshot. */
  async function inspect() {
    await deps.assertIsolated();
    // The keyring must cover the seal even when the authority inventory is empty.
    deps.ledger.assertSubjectVersions(deps.subjectKeys.derive('recovery_probe', 'user_recovery_probe').map(key => key.version));
    if (await deps.repository.recoveryIdentity() !== cutoff.target) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
    return deps.ledger.recoveryInventory(cutoff);
  }

  return {
    /** Reconcile all entries and append durable per-intent evidence. Any conflict leaves the gate closed. */
    async recover() {
      if (reconciling) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
      reconciling = true;
      completed = undefined;
      try {
        const { entries, digest } = await inspect();
        for (const row of entries) {
          const scope = decodeScope(row.scope_key);
          if (!row.challenge_key) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
          const account = await deps.repository.resolveRecovery(scope, deps.subjectKeys,
            id => deps.ledger.matchesIncarnation(row, id));
          deps.ledger.assertSubjectVersions(account.subjectKeys.map(key => key.version));
          await deps.repository.reconcile({ ...account, scopeKey: row.scope_key, fingerprint: row.fingerprint,
            policyVersion: row.policy_version }, { operationId: row.operation_id, challengeKey: row.challenge_key },
          new Date(Date.now() + deps.operationDeadlineMs));
          await deps.ledger.recordRecovery(cutoff, digest, row);
        }
        if ((await inspect()).digest !== digest) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
        await deps.ledger.verifyRecoveryProgress(cutoff, digest, entries);
        completed = { digest };
      } catch {
        throw new SecurityError('DEPENDENCY_UNAVAILABLE');
      } finally {
        reconciling = false;
      }
    },
    /** Prove only that an unaffected synthetic fixture could be read after full reconciliation. */
    async assertFixtureRead(accountId: string, ideaId: string) {
      const verification = completed;
      if (!verification) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
      try {
        const { entries, digest } = await inspect();
        if (digest !== verification.digest || verification !== completed) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
        await deps.ledger.verifyRecoveryProgress(cutoff, digest, entries);
        const { instanceId, subjectKeys } = await deps.repository.readFixtureScope(accountId, ideaId, deps.subjectKeys);
        deps.ledger.assertSubjectVersions(subjectKeys.map(key => key.version));
        const scopes = new Set([
          suppressionScopeKey({ kind: 'IDEA', instanceId, accountId, ideaId }),
          ...subjectKeys.map(key => suppressionScopeKey({ kind: 'ACCOUNT', instanceId, incarnation: 'ALL',
            subjectKeyVersion: key.version, subjectKey: key.digest }))
        ]);
        if (entries.some(row => scopes.has(row.scope_key))) throw new SecurityError('RESOURCE_NOT_FOUND');
        if (verification !== completed) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
      } catch (error) {
        if (error instanceof SecurityError && error.code === 'RESOURCE_NOT_FOUND') throw error;
        if (verification === completed) completed = undefined;
        throw new SecurityError('DEPENDENCY_UNAVAILABLE');
      }
    }
  };
}
