import { randomUUID } from 'node:crypto';
import { SecurityError } from './errors.js';

export type SuppressionScope =
  | { readonly kind: 'ACCOUNT'; readonly instanceId: string; readonly subjectKeyVersion: number;
      readonly subjectKey: string; readonly incarnation: 'ALL' }
  | { readonly kind: 'IDEA'; readonly instanceId: string; readonly accountId: string; readonly ideaId: string };
export interface SuppressionQuery { readonly nonce: string; readonly requestedAt: number }
export interface SuppressionEvidence {
  readonly verdict: 'CLEAR' | 'SUPPRESSED' | 'UNAVAILABLE';
  readonly scope: string;
  readonly nonce: string;
  readonly observedAt: number;
  readonly validUntil: number;
  readonly integrity: 'VERIFIED';
  readonly coverage: 'COMPLETE';
  readonly authority: 'INDEPENDENT';
  readonly epoch: string;
}
export interface SuppressionAuthority {
  lookup(scope: SuppressionScope, query: SuppressionQuery): Promise<SuppressionEvidence | null>;
}
export function suppressionScopeKey(scope: SuppressionScope): string {
  return scope.kind === 'ACCOUNT'
    ? JSON.stringify(['ACCOUNT', scope.instanceId, scope.subjectKeyVersion, scope.subjectKey, scope.incarnation])
    : JSON.stringify(['IDEA', scope.instanceId, scope.accountId, scope.ideaId]);
}
export async function requireClearance(authority: SuppressionAuthority, scope: SuppressionScope): Promise<void> {
  const query = Object.freeze({ nonce: randomUUID(), requestedAt: Date.now() });
  let evidence: SuppressionEvidence | null;
  try { evidence = await authority.lookup(Object.freeze({ ...scope }), query); }
  catch { throw new SecurityError('DEPENDENCY_UNAVAILABLE'); }
  const now = Date.now();
  if (!evidence || evidence.scope !== suppressionScopeKey(scope) || evidence.nonce !== query.nonce ||
    evidence.authority !== 'INDEPENDENT' || evidence.integrity !== 'VERIFIED' || evidence.coverage !== 'COMPLETE' ||
    !Number.isFinite(evidence.observedAt) || evidence.observedAt < query.requestedAt || evidence.observedAt > now ||
    !Number.isFinite(evidence.validUntil) || evidence.validUntil <= now ||
    typeof evidence.epoch !== 'string' || evidence.epoch.length === 0 || evidence.epoch.length > 256 ||
    evidence.verdict !== 'CLEAR') throw new SecurityError('DEPENDENCY_UNAVAILABLE');
}
