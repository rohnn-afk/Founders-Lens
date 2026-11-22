// Isolated PostgreSQL authority adapter. Storage establishes a consistent
// inventory; trusted composition supplies its expected epoch and integrity key.
// Application startup does not compose this proof adapter.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
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
}
interface CoverageRow {
  epoch: string | null;
  subject_versions: number[] | null;
  coverage_integrity: string | null;
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
}) {
  const epoch = trusted.epoch;
  const key = Buffer.from(trusted.integrityKey);
  const versions = [...trusted.subjectVersions].sort((a, b) => a - b);
  if (!uuid.test(epoch) || key.length < 32 || versions.length < 1 || versions.length > 16 ||
    new Set(versions).size !== versions.length || versions.some(v => !Number.isInteger(v) || v < 1 || v > 2147483647)) {
    throw new Error('Invalid suppression ledger configuration');
  }
  const mac = (data: unknown) => createHmac('sha256', key).update(JSON.stringify(data)).digest('hex');
  const authentic = (actual: string | null, expected: string) => typeof actual === 'string' && digest.test(actual) &&
    timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
  const intentMac = (row: Omit<IntentRow, 'integrity'>) =>
    mac(['suppression-intent-v1', row.operation_id, row.scope_key, row.fingerprint, row.policy_version]);
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
      !authentic(row.coverage_integrity, mac(['suppression-coverage-v1', epoch, versions]))) {
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
    const row = (await query<CoverageRow>(`SELECT c.epoch,c.subject_versions,c.integrity AS coverage_integrity,
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
    /** Conditionally append an intent and return its verified winning operation ID. */
    async admit(intent: SuppressionIntent): Promise<string> {
      const row = intentFields(intent);
      // A separate read uses a new snapshot after a concurrent insert wins.
      // Errors remain uncertain until the caller recovers the same identity.
      await query(`INSERT INTO authority.intent(operation_id,scope_key,fingerprint,policy_version,integrity)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [row.operation_id, row.scope_key, row.fingerprint, row.policy_version, intentMac(row)]);
      return recover(intent);
    },
    inventory: snapshot
  };
}
