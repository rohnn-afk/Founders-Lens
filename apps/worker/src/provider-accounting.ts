/** Immutable provider observation. Reservations and observations use separate facts. */
import type { PoolClient } from 'pg';
import type { ProviderResult } from './founder-provider.js';

export async function observedUsage(tx: PoolClient, attempt: string) {
  const { rows } = await tx.query<{ leaseEpoch: number; totalTokens: number; inputTokens: number;
    outputTokens: number; responseId: string | null }>(`
    SELECT "leaseEpoch","inputTokens","outputTokens","totalTokens","responseId"
    FROM public."GenerationProviderReceipt" WHERE "attemptId"=$1`, [attempt]);
  return rows[0];
}

/** The caller owns the locked generation and commits the receipt and ledger together. */
export async function recordObservation(tx: PoolClient, attempt: string, lease: number,
  result: Pick<ProviderResult, 'usage' | 'responseId'>) {
  const { usage, responseId } = result;
  if (!usage || ![usage.inputTokens, usage.outputTokens, usage.totalTokens]
    .every(value => Number.isInteger(value) && value >= 0 && value <= 2147483647) ||
    usage.inputTokens + usage.outputTokens > usage.totalTokens ||
    (responseId !== null && !/^[A-Za-z0-9_.:-]{1,160}$/.test(responseId))) return false;
  const existing = await observedUsage(tx, attempt);
  if (existing) return existing.leaseEpoch === lease && existing.responseId === responseId &&
    existing.inputTokens === usage.inputTokens && existing.outputTokens === usage.outputTokens &&
    existing.totalTokens === usage.totalTokens;
  await tx.query(`INSERT INTO public."GenerationProviderReceipt"
    ("attemptId","leaseEpoch","responseId","inputTokens","outputTokens","totalTokens") VALUES ($1,$2,$3,$4,$5,$6)`,
  [attempt, lease, responseId, usage.inputTokens, usage.outputTokens, usage.totalTokens]);
  return true;
}
