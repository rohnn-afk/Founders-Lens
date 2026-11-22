/** Verify attempt scope references against a live operator decision and independent ledger. */
import { z } from 'zod';
import type { Pool } from 'pg';
import type { RuntimeRecoveryDecision } from '../privacy/runtime-recovery-clearance.js';
import { SecurityError } from '../security/errors.js';
import { requireClearance, suppressionWindow, type SuppressionAuthority } from '../security/suppression-authority.js';

const reference = z.strictObject({ version: z.number().int().positive().max(2147483647),
  digest: z.string().regex(/^[a-f0-9]{64}$/) });
const scope = z.strictObject({
  version: z.literal(1), primaryTarget: z.string(), authorityIdentity: z.string(), namespace: z.string(),
  recoveryRun: z.uuid(), accountId: z.uuid(), ideaId: z.uuid(), conversationId: z.uuid(),
  instanceId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), messageId: z.uuid(), generationId: z.uuid(),
  accountKeys: z.array(reference).min(1).max(16)
});

type LockedScope = Pick<z.infer<typeof scope>, 'accountId' | 'ideaId' | 'conversationId' |
  'instanceId' | 'messageId' | 'generationId'> & { accountKey: z.infer<typeof reference> };

/** Resolve the exact attempt and account binding without granting access to message content. */
export function createExecutionAuthorizer(primary: Pool, authority: SuppressionAuthority,
  verifyDecision: () => Promise<RuntimeRecoveryDecision>, purpose: 'dispatch' | 'execute',
  approved?: { accountId: string; conversationId: string }) {
  return async (attemptId: string) => {
    if (!z.uuid().safeParse(attemptId).success) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
    const query = {
      text: `SELECT a.id AS "accountId",i.id AS "ideaId",c.id AS "conversationId",
        a."clerkInstanceId" AS "instanceId",g.id AS "generationId",m.id AS "messageId",
        json_build_object('version',a."subjectKeyVersion",'digest',a."subjectKey") AS "accountKey",
        g."orchestrationMetadata"->'executionScope' AS "executionScope",
        p.system_identifier::text || ':' || db.oid::text AS target
      FROM "GenerationAttempt" g
      JOIN "Conversation" c ON c.id=g."conversationId"
      JOIN "Idea" i ON i.id=c."ideaId"
      JOIN "UserAccount" a ON a.id=i."ownerId"
      JOIN "Message" m ON m.id=g."triggerMessageId" AND m."conversationId"=c.id AND m."ideaId"=i.id
      CROSS JOIN pg_catalog.pg_control_system() p
      JOIN pg_catalog.pg_database db ON db.datname=current_database()
      WHERE g.id=$1 AND g."deadlineAt">clock_timestamp() AND g.status IN ('PENDING','RUNNING')
        AND a.status='ACTIVE' AND i.status='ACTIVE' AND c.status='ACTIVE' AND m.role='USER'
        AND NOT EXISTS (SELECT 1 FROM "DataOperation" d WHERE
          (d.kind='DELETE_ACCOUNT' AND (d."accountId"=a.id OR
            (d."clerkInstanceId"=a."clerkInstanceId" AND d."ownerSubjectKey"=a."subjectKey"
              AND d."subjectKeyVersion"=a."subjectKeyVersion")))
          OR (d.kind='DELETE_IDEA' AND d."ideaId"=i.id))
        AND NOT EXISTS (SELECT 1 FROM "IdentityTombstone" t WHERE t."clerkInstanceId"=a."clerkInstanceId"
          AND t."subjectKey"=a."subjectKey" AND t."subjectKeyVersion"=a."subjectKeyVersion")`,
      values: [attemptId], query_timeout: 1500
    };
    const { rows: [row] } = await primary.query<LockedScope & { executionScope: unknown; target: string }>(query);
    if (!row || (approved && (row.accountId !== approved.accountId || row.conversationId !== approved.conversationId))) {
      throw new SecurityError('DEPENDENCY_UNAVAILABLE');
    }
    return verifyExecutionScope(row.executionScope, row, authority, async () => {
      const decision = await verifyDecision();
      if (decision.primaryTarget !== row.target) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
      return decision;
    }, purpose);
  };
}

/**
 * Check the complete reference set outside primary transactions. The caller
 * must still enforce its locked attempt, lease and lifecycle fences.
 */
export async function verifyExecutionScope(value: unknown, current: LockedScope, authority: SuppressionAuthority,
  verifyDecision: () => Promise<RuntimeRecoveryDecision>, purpose: 'dispatch' | 'execute') {
  const parsed = scope.safeParse(value);
  const decision = await verifyDecision();
  if (!parsed.success || decision.purpose !== ('founders-lens:local-generation:' + purpose)) {
    throw new SecurityError('DEPENDENCY_UNAVAILABLE');
  }
  const saved = parsed.data;
  const fields = ['accountId', 'ideaId', 'conversationId', 'instanceId', 'messageId', 'generationId'] as const;
  if (fields.some(field => saved[field] !== current[field]) || saved.primaryTarget !== decision.primaryTarget ||
    saved.authorityIdentity !== decision.authorityIdentity || saved.namespace !== decision.namespace ||
    saved.recoveryRun !== decision.recoveryRun ||
    !saved.accountKeys.some(key => key.version === current.accountKey.version && key.digest === current.accountKey.digest)) {
    throw new SecurityError('DEPENDENCY_UNAVAILABLE');
  }
  if (saved.accountKeys.map(key => key.version).join(',') !== decision.subjectVersions.join(',')) {
    // Existing attempts cannot derive a new version without fresh authenticated admission.
    throw new SecurityError('DEPENDENCY_UNAVAILABLE');
  }
  const window = suppressionWindow({ async lookup(key, query) {
    const evidence = await authority.lookup(key, query);
    return evidence?.epoch === decision.epoch ? evidence : null;
  } });
  for (const key of saved.accountKeys) {
    await requireClearance(window.authority, { kind: 'ACCOUNT', instanceId: saved.instanceId,
      subjectKeyVersion: key.version, subjectKey: key.digest, incarnation: 'ALL' });
  }
  await requireClearance(window.authority, { kind: 'IDEA', instanceId: saved.instanceId,
    accountId: saved.accountId, ideaId: saved.ideaId });
  if (JSON.stringify(await verifyDecision()) !== JSON.stringify(decision)) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
  window.requireFresh();
  if (Date.now() >= decision.expiresAt) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
  return Math.min(window.deadline(), decision.expiresAt);
}

/**
 * Install a short-lived projection grant using a separate trusted database login.
 * The configured claimant is the restricted context connection's PostgreSQL login.
 */
export function createContextGrantIssuer(primary: Pool, authority: SuppressionAuthority,
  verifyDecision: () => Promise<RuntimeRecoveryDecision>, claimant: string,
  approved?: { accountId: string; conversationId: string }) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(claimant)) throw new Error('Invalid context login');
  const authorize = createExecutionAuthorizer(primary, authority, verifyDecision, 'execute', approved);
  return async (attempt: string, lease: number, contextVersion: number) => {
    const expiry = await authorize(attempt);
    const { rowCount } = await primary.query(`
      WITH bound AS (
        SELECT id,"leaseUntil","deadlineAt" FROM public."GenerationAttempt" g
        WHERE g.id=$1 AND g."leaseEpoch"=$2 AND g."contextEpoch"=$3 AND status='RUNNING'
          AND g."leaseUntil">clock_timestamp() AND g."deadlineAt">clock_timestamp()
          AND to_timestamp($5::double precision/1000)>clock_timestamp()
          AND g."leaseClaimant"=$4::varchar(63)
      )
      INSERT INTO p9_context.context_grant (attempt_id,lease_epoch,context_epoch,valid_until)
      SELECT id,$2,$3,least("leaseUntil","deadlineAt",to_timestamp($5::double precision/1000)) FROM bound
      ON CONFLICT (attempt_id) DO UPDATE SET lease_epoch=excluded.lease_epoch,
        context_epoch=excluded.context_epoch,valid_until=excluded.valid_until
      WHERE p9_context.context_grant.lease_epoch<=excluded.lease_epoch`, [attempt, lease, contextVersion, claimant, expiry]);
    if (rowCount !== 1) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
  };
}
