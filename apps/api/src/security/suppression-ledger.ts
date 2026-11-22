// Isolated PostgreSQL authority adapter. Storage establishes a consistent
// inventory; trusted composition supplies its expected epoch and integrity key.
// Application startup does not compose this proof adapter.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import type { VerifiedDeletionReverification } from './clerk.js';
import { suppressionScopeKey, type SuppressionAuthority, type SuppressionScope } from './suppression-authority.js';

/** Opaque deletion intent. The fingerprint binds the canonical request and its preconditions. */
export interface SuppressionIntent {
  readonly operationId: string;
  readonly scope: SuppressionScope;
  readonly fingerprint: string;
  readonly policyVersion: string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const identifier = /^[A-Za-z0-9_-]{1,100}$/;

/** Validate and encode an exact account-key version or account-owned idea scope. */
function scopeKey(scope: SuppressionScope): string {
  if (!identifier.test(scope.instanceId)) throw new Error('Invalid suppression scope');
  if (scope.kind === 'ACCOUNT' && scope.incarnation === 'ALL' && Number.isSafeInteger(scope.subjectKeyVersion) &&
    scope.subjectKeyVersion > 0 && digest.test(scope.subjectKey)) return suppressionScopeKey(scope);
  if (scope.kind === 'IDEA' && uuid.test(scope.accountId) && uuid.test(scope.ideaId)) return suppressionScopeKey(scope);
  throw new Error('Invalid suppression scope');
}

interface IntentRow {
  operation_id: string;
  scope_key: string;
  fingerprint: string;
  policy_version: string;
  integrity: string;
  challenge_key: string | null;
}
interface CoverageRow {
  epoch: string | null;
  subject_versions: number[] | null;
  coverage_integrity: string | null;
  challenge_namespace: string | null;
  total: string;
  inventory: IntentRow[];
}

/**
 * Compose a ledger over a caller-owned, independently managed PostgreSQL pool.
 * Use a bounded connection timeout. Invalid trust configuration throws up front.
 * Lookup returns no clearance on failure; admission and recovery reject uncertainty.
 * The caller owns pool shutdown and checks every retained account-key version.
 */
export function createSuppressionLedger(pool: Pool, trusted: {
  epoch: string;
  integrityKey: Uint8Array;
  subjectVersions: readonly number[];
  /** Writer-only derivation material. Readers can pin the public namespace identity instead. */
  challengeKey?: Uint8Array;
  challengeNamespace?: string;
}) {
  const epoch = trusted.epoch;
  const key = Buffer.from(trusted.integrityKey);
  const versions = [...trusted.subjectVersions].sort((a, b) => a - b);
  if (!uuid.test(epoch) || key.length < 32 || versions.length < 1 || versions.length > 16 ||
    new Set(versions).size !== versions.length || versions.some(v => !Number.isInteger(v) || v < 1 || v > 2147483647)) {
    throw new Error('Invalid suppression ledger configuration');
  }
  const mac = (data: unknown) => createHmac('sha256', key).update(JSON.stringify(data)).digest('hex');
  const challengeSecret = trusted.challengeKey && Buffer.from(trusted.challengeKey);
  if (challengeSecret && (challengeSecret.length < 32 || challengeSecret.equals(key))) {
    throw new Error('An independent challenge derivation key is required');
  }
  function challengeMac(data: unknown) {
    if (!challengeSecret) throw new Error('Challenge writer key unavailable');
    return createHmac('sha256', challengeSecret).update(JSON.stringify(data)).digest('hex');
  }
  // V1 is a fixed namespace, not a per-record key choice. Replacing its key
  // requires a migration that preserves the uniqueness of all reservations.
  const derivedNamespace = challengeSecret ? 'hmac-sha256-v1:' + challengeMac(['deletion-challenge-namespace-v1']) : null;
  if (trusted.challengeNamespace !== undefined &&
    (!/^hmac-sha256-v1:[0-9a-f]{64}$/.test(trusted.challengeNamespace) ||
      (derivedNamespace !== null && derivedNamespace !== trusted.challengeNamespace))) {
    throw new Error('Invalid challenge namespace identity');
  }
  const namespace = derivedNamespace ?? trusted.challengeNamespace ?? null;
  const coverageTag = mac(namespace === null ? ['suppression-coverage-v1', epoch, versions] :
    ['suppression-coverage-v2', epoch, versions, namespace]);
  const authentic = (actual: string | null, expected: string) => typeof actual === 'string' && digest.test(actual) &&
    timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
  const intentMac = (row: Omit<IntentRow, 'integrity'>) =>
    mac(row.challenge_key === null ?
      ['suppression-intent-v1', row.operation_id, row.scope_key, row.fingerprint, row.policy_version] :
      ['suppression-intent-v2', row.operation_id, row.scope_key, row.fingerprint, row.policy_version, row.challenge_key]);
  /** Return the stored row only when its domain-separated integrity tag matches. */
  function verifyIntent(row: IntentRow) {
    if (!authentic(row.integrity, intentMac(row))) throw new Error('Suppression intent integrity failure');
    return row;
  }
  /** Reject absent, stale, or unauthenticated operator coverage. */
  function verifyCoverage(row: CoverageRow | undefined) {
    // The epoch is supplied outside this database. A restore must start with a
    // new expected epoch until an operator has reconciled and sealed coverage.
    if (!row || row.epoch !== epoch || JSON.stringify(row.subject_versions) !== JSON.stringify(versions) ||
      row.challenge_namespace !== namespace || !authentic(row.coverage_integrity, coverageTag)) {
      throw new Error('Suppression coverage unavailable');
    }
  }
  async function query<Row extends IntentRow | CoverageRow>(text: string, values: string[] = []) {
    const options = { text, values, query_timeout: 1500 };
    return pool.query<Row>(options);
  }
  /** Return the complete authenticated proof inventory or reject without a partial result. */
  async function snapshot() {
    // Slice 1 checks the entire small fixture inventory in one MVCC snapshot.
    // Bound the result and fail closed when this proof-sized limit is exceeded.
    const row = (await query<CoverageRow>(`SELECT c.epoch,c.subject_versions,c.challenge_namespace,c.integrity AS coverage_integrity,
      n.total,COALESCE((SELECT json_agg(i) FROM
        (SELECT * FROM authority.intent ORDER BY scope_key LIMIT 257) i),'[]'::json) AS inventory
      FROM authority.inventory_count n LEFT JOIN authority.coverage c ON c.singleton WHERE n.singleton`)).rows[0];
    verifyCoverage(row);
    if (!row || row.inventory.length > 256 || String(row.inventory.length) !== row.total) {
      throw new Error('Suppression inventory incomplete');
    }
    return row.inventory.map(verifyIntent);
  }

  const authority: SuppressionAuthority = {
    async lookup(scope, request) {
      try {
        const exactScope = scopeKey(scope);
        if (scope.kind === 'ACCOUNT' && !versions.includes(scope.subjectKeyVersion)) return null;
        const rows = await snapshot();
        // Bind evidence to this request and include database latency in its lifetime.
        const observedAt = Date.now();
        const validUntil = request.requestedAt + 2000;
        if (observedAt < request.requestedAt || validUntil <= observedAt || !uuid.test(request.nonce)) return null;
        return { verdict: rows.some(row => row.scope_key === exactScope) ? 'SUPPRESSED' : 'CLEAR', scope: exactScope,
          nonce: request.nonce, observedAt, validUntil, integrity: 'VERIFIED', coverage: 'COMPLETE',
          authority: 'INDEPENDENT', epoch };
      } catch {
        return null;
      }
    }
  };

  /** Validate the admission input before writing or comparing stored identity. */
  function intentFields(intent: SuppressionIntent) {
    const scope = scopeKey(intent.scope);
    if (!uuid.test(intent.operationId) || !digest.test(intent.fingerprint) ||
      !/^[A-Za-z0-9_-]{1,60}$/.test(intent.policyVersion) ||
      (intent.scope.kind === 'ACCOUNT' && !versions.includes(intent.scope.subjectKeyVersion))) {
      throw new Error('Invalid suppression intent');
    }
    return { operation_id: intent.operationId, scope_key: scope, fingerprint: intent.fingerprint,
      policy_version: intent.policyVersion };
  }

  /** Read back the winning operation ID without writing, or reject missing or conflicting intent. */
  async function recover(intent: SuppressionIntent): Promise<string> {
    const expected = intentFields(intent);
    const rows = (await query<IntentRow>(`SELECT * FROM authority.intent
      WHERE operation_id=$1 OR scope_key=$2`, [expected.operation_id, expected.scope_key])).rows;
    if (rows.length !== 1) throw new Error('Suppression intent unresolved or conflicting');
    const row = verifyIntent(rows[0]!);
    if (row.scope_key !== expected.scope_key || row.fingerprint !== expected.fingerprint ||
      row.policy_version !== expected.policy_version) throw new Error('Conflicting suppression intent');
    return row.operation_id;
  }

  return {
    authority,
    recover,
    /** Refuse admission unless the configured ledger covers every retained subject key. */
    assertSubjectVersions(retained: readonly number[]): void {
      if (JSON.stringify([...retained].sort((a, b) => a - b)) !== JSON.stringify(versions)) {
        throw new Error('Incomplete retained subject-key coverage');
      }
    },
    /** Conditionally append an intent and return its verified winning operation ID. */
    async admit(intent: SuppressionIntent): Promise<string> {
      const row = intentFields(intent);
      if (namespace !== null) throw new Error('Challenge reservation required');
      // A separate read uses a new snapshot after a concurrent insert wins.
      // Errors remain uncertain until the caller recovers the same identity.
      await query(`INSERT INTO authority.intent(operation_id,scope_key,fingerprint,policy_version,integrity)
        SELECT $1::uuid,$2,$3,$4,$5 FROM authority.coverage
        WHERE singleton AND challenge_namespace IS NULL
        ON CONFLICT DO NOTHING`,
      [row.operation_id, row.scope_key, row.fingerprint, row.policy_version, intentMac({ ...row, challenge_key: null })]);
      return recover(intent);
    },
    /** Reserve the verified challenge and intent together, then authenticate the winning snapshot. */
    async reserve(intent: SuppressionIntent, evidence: VerifiedDeletionReverification) {
      if (!namespace || !challengeSecret || evidence.identity.instanceId !== intent.scope.instanceId ||
        !Number.isSafeInteger(evidence.validUntil) || evidence.validUntil <= Date.now()) {
        throw new Error('Deletion challenge unavailable');
      }
      const expected = { ...intentFields(intent), challenge_key: challengeMac(['deletion-challenge-use-v1',
        evidence.identity.instanceId, evidence.identity.subject, evidence.identity.sessionId, evidence.challengeId]) };
      await snapshot();
      try {
        // The insert matches the authenticated seal. The database trigger locks
        // and rechecks the epoch and namespace before accepting the reservation.
        await query(`INSERT INTO authority.intent(operation_id,scope_key,fingerprint,policy_version,integrity,
          challenge_key,reservation_epoch,reservation_namespace)
          SELECT $1::uuid,$2,$3,$4,$5,$6,$7::uuid,$8 FROM authority.coverage
          WHERE singleton AND epoch=$7 AND challenge_namespace=$8 AND integrity=$9
            AND clock_timestamp() < to_timestamp($10::double precision/1000)
          ON CONFLICT DO NOTHING`,
        [expected.operation_id, expected.scope_key, expected.fingerprint, expected.policy_version,
          intentMac(expected), expected.challenge_key, epoch, namespace, coverageTag, String(evidence.validUntil)]);
      } catch {
        // A failed reply is ambiguous. Only a matching authenticated read-back can resolve it.
      }
      const winner = (await snapshot()).find(row => row.challenge_key === expected.challenge_key);
      if (!winner || winner.scope_key !== expected.scope_key || winner.fingerprint !== expected.fingerprint ||
        winner.policy_version !== expected.policy_version || evidence.validUntil <= Date.now()) {
        throw new Error('Conflicting or unresolved challenge reservation');
      }
      return { operationId: winner.operation_id, challengeKey: expected.challenge_key };
    },
    /** Verify an already committed receipt against current authenticated authority coverage. */
    async verifyReservation(intent: SuppressionIntent, challengeKey: string): Promise<void> {
      const expected = intentFields(intent);
      if (!namespace || !(await snapshot()).some(row => row.challenge_key === challengeKey &&
        row.operation_id === expected.operation_id && row.scope_key === expected.scope_key &&
        row.fingerprint === expected.fingerprint && row.policy_version === expected.policy_version)) {
        throw new Error('Committed suppression reservation unavailable');
      }
    },
    inventory: snapshot
  };
}
