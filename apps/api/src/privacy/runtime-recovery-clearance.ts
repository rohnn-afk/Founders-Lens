// Unmounted local workspace recovery guard. The operator signs outside the API
// process; the verifier compares that decision with both live PostgreSQL stores.
import { verify, type KeyObject } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { SecurityError } from '../security/errors.js';
import type { SubjectKeys } from '../security/subject-key.js';
import type { createSuppressionLedger } from '../security/suppression-ledger.js';

const target = z.string().regex(/^[1-9][0-9]{0,19}:[1-9][0-9]{0,9}$/);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const versions = z.array(z.number().int().min(1).max(2147483647)).min(1).max(16)
  .refine(value => value.every((version, index) => index === 0 || version > value[index - 1]!));
const decisionSchema = z.strictObject({
  version: z.literal(1),
  purpose: z.enum(['founders-lens:local-workspace:read-only', 'founders-lens:local-workspace:create-idea']),
  primaryTarget: target,
  authorityIdentity: target,
  namespace: z.string().regex(/^hmac-sha256-v1:[0-9a-f]{64}$/),
  epoch: z.uuid(),
  recoveryRun: z.uuid(),
  inventoryDigest: z.string().regex(/^[0-9a-f]{64}$/),
  subjectVersions: versions,
  issuedAt: time,
  expiresAt: time
});
const envelopeSchema = z.strictObject({
  payload: z.string().max(2048).regex(/^[A-Za-z0-9_-]+$/),
  signature: z.string().length(86).regex(/^[A-Za-z0-9_-]+$/)
});
const maximumLifetimeMs = 5 * 60_000;

/** Canonical Ed25519 payload. Serialize in schema order with JSON.stringify and sign its UTF-8 bytes. */
export type RuntimeRecoveryDecision = Readonly<z.infer<typeof decisionSchema>>;

/** Authenticate the decision before using its binding fields. Reject alternate byte encodings. */
function readDecision(encoded: string, publicKey: KeyObject): RuntimeRecoveryDecision {
  if (encoded.length > 2300) throw new Error('Recovery decision unavailable');
  const envelope = envelopeSchema.parse(JSON.parse(encoded));
  const payload = Buffer.from(envelope.payload, 'base64url');
  const signature = Buffer.from(envelope.signature, 'base64url');
  if (JSON.stringify(envelope) !== encoded || payload.toString('base64url') !== envelope.payload ||
    signature.toString('base64url') !== envelope.signature ||
    !verify(null, payload, publicKey, signature)) throw new Error('Recovery signature unavailable');
  const decision = decisionSchema.parse(JSON.parse(payload.toString('utf8')));
  if (!payload.equals(Buffer.from(JSON.stringify(decision))) ||
    decision.expiresAt <= decision.issuedAt || decision.expiresAt - decision.issuedAt > maximumLifetimeMs ||
    decision.primaryTarget.split(':')[0] === decision.authorityIdentity.split(':')[0]) {
    throw new Error('Recovery decision policy unavailable');
  }
  return decision;
}

/** Read control identity from the selected pool. A restored application row cannot attest its own target. */
async function readPrimaryTarget(pool: Pool): Promise<string> {
  const query = { text: `SELECT system_identifier::text || ':' || d.oid::text AS identity
    FROM pg_catalog.pg_control_system(), pg_catalog.pg_database d WHERE d.datname=current_database()`,
    query_timeout: 1500 };
  const { rows } = await pool.query<{ identity: string }>(query);
  return target.parse(rows[0]?.identity);
}

/**
 * Verify a separately issued, target-bound recovery decision on each read.
 * The proof requires fresh restore targets. An in-place restore is unsupported
 * because it can retain both PostgreSQL identifiers. No successful result is cached.
 */
export function createRuntimeRecoveryClearance(deps: {
  readonly decision: string;
  readonly operatorPublicKey: KeyObject;
  readonly primary: Pool;
  readonly authority: Pick<ReturnType<typeof createSuppressionLedger>, 'runtimeSnapshot'>;
  readonly subjectKeys: SubjectKeys;
  readonly purpose?: RuntimeRecoveryDecision['purpose'];
}) {
  const { decision: encoded, operatorPublicKey, primary, authority, subjectKeys } = deps;
  const clockIsValid = (decision: RuntimeRecoveryDecision) => {
    const now = Date.now();
    return decision.issuedAt <= now && now < decision.expiresAt;
  };
  return {
    /** Resolve only when both live stores still match this independently signed decision. */
    async assertClearance(): Promise<void> { await verifiedDeadline(); },
    verifiedDeadline
  };

  /** Return the signed deadline for local transaction checks without authority I/O under locks. */
  async function verifiedDeadline(): Promise<number> {
      try {
        if (process.env['NODE_ENV'] === 'production' || operatorPublicKey.type !== 'public' ||
          operatorPublicKey.asymmetricKeyType !== 'ed25519' || !primary.options.connectionTimeoutMillis ||
          primary.options.connectionTimeoutMillis > 5000) throw new Error('Local recovery verification unavailable');
        const decision = readDecision(encoded, operatorPublicKey);
        if (decision.purpose !== (deps.purpose ?? 'founders-lens:local-workspace:read-only') ||
          !clockIsValid(decision)) throw new Error('Recovery decision unavailable for this operation');
        const retained = subjectKeys.derive('recovery_probe', 'user_recovery_probe').map(key => key.version)
          .sort((a, b) => a - b);
        const sameVersions = (actual: readonly number[]) =>
          actual.length === decision.subjectVersions.length && actual.every((key, index) => key === decision.subjectVersions[index]);
        if (!sameVersions(retained) || await readPrimaryTarget(primary) !== decision.primaryTarget) {
          throw new Error('Primary or retained keys do not match');
        }
        const current = await authority.runtimeSnapshot();
        if (current.authorityIdentity !== decision.authorityIdentity || current.namespace !== decision.namespace ||
          current.epoch !== decision.epoch || current.inventoryDigest !== decision.inventoryDigest ||
          !sameVersions(current.subjectVersions) || !clockIsValid(decision)) throw new Error('Authority state changed');
        return decision.expiresAt;
      } catch {
        throw new SecurityError('DEPENDENCY_UNAVAILABLE');
      }
  }
}
