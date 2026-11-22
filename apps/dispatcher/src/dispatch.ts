// Isolated dispatch coordinator. It combines the PostgreSQL outbox, broker
// and injected synthetic suppression evidence without loading founder content.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { isUuid, policy } from './config.js';
import type { GenerationQueue } from './generation-queue.js';
import type { Event, Failure, OutboxRepository, Scope } from './outbox-repository.js';

type Evidence = {
  scope: string; nonce: string; verdict: 'CLEAR' | 'SUPPRESSED' | 'UNAVAILABLE';
  observedAt: number; validUntil: number;
};
type Authority = (scope: string, query: { nonce: string; requestedAt: number }) => Promise<Evidence | null>;
type Report = (outcome: string, eventId?: string) => void;
const scopeIdentity = ({ accountId, ideaId, conversationId, instanceId, subjectKey, subjectKeyVersion }: Scope) =>
  JSON.stringify([accountId, ideaId, conversationId, instanceId, subjectKey, subjectKeyVersion]);

export function backoff(attempt: number, random = Math.random) {
  const cap = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (attempt - 1));
  const low = Math.ceil(cap / 2);
  return low + Math.floor(random() * (cap - low + 1));
}

function generation(event: Event) {
  const payload = event.payload;
  return (event.kind === 'generation.requested' || event.kind === 'p9.generation.requested') &&
    event.aggregateType === 'GenerationAttempt' &&
    isUuid(event.aggregateId) && payload !== null && typeof payload === 'object' &&
    Object.keys(payload).length === 1 && 'generationId' in payload && payload.generationId === event.aggregateId
    ? event.aggregateId : undefined;
}

export function dispatcher(repository: OutboxRepository, queue: GenerationQueue, authority: Authority,
  report: Report, { now = Date.now, monotonic = () => performance.now(), random = Math.random,
    verifyExecution }: { now?: () => number; monotonic?: () => number; random?: () => number;
    verifyExecution?: (attemptId: string, scope: Scope) => Promise<number> } = {}) {
  let active: Promise<void> | undefined;
  let stopping = false;
  let closed = false;

  async function clearance(scope: Scope) {
    // Evidence is fresh and scoped to the database-resolved account and idea.
    // Both results must still be valid immediately before broker access.
    const scopes = [
      JSON.stringify(['ACCOUNT', scope.instanceId, scope.subjectKeyVersion, scope.subjectKey, 'ALL']),
      JSON.stringify(['IDEA', scope.instanceId, scope.accountId, scope.ideaId])
    ];
    let validUntil = Infinity;
    try {
      for (const scope of scopes) {
        const query = { nonce: randomUUID(), requestedAt: now() };
        const evidence = await authority(scope, query);
        if (!evidence || evidence.verdict !== 'CLEAR' || evidence.scope !== scope || evidence.nonce !== query.nonce ||
          !Number.isFinite(evidence.observedAt) || evidence.observedAt < query.requestedAt || evidence.observedAt > now() ||
          !Number.isFinite(evidence.validUntil) || evidence.validUntil <= now()) return undefined;
        validUntil = Math.min(validUntil, evidence.validUntil);
      }
      return validUntil;
    } catch { return undefined; }
  }

  async function fail(event: Event, code: Failure, terminal = false) {
    if (closed) return;
    const status = await repository.fail(event, code, terminal ? 0 : backoff(event.dispatchAttempts, random), terminal);
    report(status === 'FAILED' ? 'FAILED:' + code : status ? 'RETRY:' + code : 'STALE_CLAIM', event.id);
  }

  async function authorize(event: Event, published = false, expected?: string) {
    const started = monotonic();
    const scope = await repository.scope(event, published);
    if (closed || !scope || (expected !== undefined && expected !== scopeIdentity(scope))) return 'INELIGIBLE' as const;
    const expires = verifyExecution
      ? await verifyExecution(event.aggregateId, scope).catch(() => undefined)
      : await clearance(scope);
    if (closed || !expires || expires <= now()) return 'SUPPRESSION_UNAVAILABLE' as const;
    const checked = monotonic();
    const current = await repository.scope(event, published);
    if (closed || !current || scopeIdentity(current) !== scopeIdentity(scope)) return 'INELIGIBLE' as const;
    // PostgreSQL supplies durations so the broker budget does not depend on
    // clock synchronization. Count each query's transit time conservatively.
    const remainingMs = () => Math.min(expires - now(),
      Math.min(started + scope.remainingMs, checked + current.remainingMs) - monotonic());
    if (!(remainingMs() > 0)) return 'INELIGIBLE' as const;
    return { remainingMs, identity: scopeIdentity(scope) };
  }

  async function deliver(event: Event) {
    const id = generation(event);
    if (!id) return fail(event, 'INVALID_EVENT', true);
    const initial = await authorize(event);
    if (closed) return;
    if (typeof initial === 'string') return fail(event, initial);
    let denial: Failure = 'INELIGIBLE';
    let broker;
    try {
      broker = await queue.publish(id, {
        remainingMs: initial.remainingMs,
        async recheck() {
          const latest = await authorize(event, false, initial.identity);
          if (typeof latest !== 'string') return latest.remainingMs;
          denial = latest;
          return undefined;
        }
      });
    }
    catch { return fail(event, 'BROKER_UNCERTAIN'); }
    if (closed) return;
    if (broker === 'blocked') return fail(event, denial);
    if (broker === 'mismatch' || broker === 'failed') return fail(event, 'BROKER_MISMATCH', true);
    if (broker !== 'retained') return fail(event, 'BROKER_UNCERTAIN');
    report(await repository.acknowledge(event) ? 'PUBLISHED' : 'STALE_CLAIM', event.id);
  }

  // A single dispatcher runs only one batch or explicit reconciliation at a time.
  function exclusive(work: () => Promise<void>) {
    if (stopping || active) return Promise.resolve();
    active = work().finally(() => { active = undefined; });
    return active;
  }

  function poll() {
    return exclusive(async () => {
      const { events, exhausted } = await repository.claim();
      for (const id of exhausted) report('FAILED:DISPATCH_EXHAUSTED', id);
      for (const event of events) {
        if (stopping) break;
        await deliver(event);
      }
    });
  }

  return {
    poll,
    async run(signal: AbortSignal) {
      const stop = () => { stopping = true; };
      signal.addEventListener('abort', stop, { once: true });
      try {
        while (!stopping && !signal.aborted) {
          try { await poll(); } catch { report('DISPATCH_UNAVAILABLE'); }
          if (!stopping) await sleep(policy.pollMs, undefined, { signal }).catch(() => {});
        }
      } finally { signal.removeEventListener('abort', stop); }
    },
    reconcile(ids: readonly string[]) {
      if (!ids.length || ids.length > policy.batch || !ids.every(isUuid) || new Set(ids).size !== ids.length) {
        throw new Error('Reconciliation requires one to four exact fixture IDs');
      }
      repository.assertFixtures(ids);
      return exclusive(async () => {
        // Only a confirmed broker miss can reopen a published intent. This
        // operation shares the ordinary durable attempt and deadline budget.
        for (const id of ids) {
          if (stopping) break;
          const event = await repository.published(id);
          const job = event && generation(event);
          if (!event || !job) continue;
          const authorization = await authorize(event, true);
          if (closed || typeof authorization === 'string') continue;
          try { if (await queue.lookup(job, authorization.remainingMs) !== 'missing') continue; }
          catch { report('RECONCILIATION_UNAVAILABLE', id); continue; }
          if (closed || authorization.remainingMs() <= 0) continue;
          const claimed = await repository.reclaimPublished(event);
          if (claimed) await deliver(claimed);
        }
      });
    },
    async close() {
      // Stop taking new work immediately. An unfinished batch stays durable
      // and can be reclaimed after its lease expires.
      stopping = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([active?.catch(() => {}) ?? Promise.resolve(),
          new Promise<void>(resolve => { timer = setTimeout(resolve, policy.shutdownMs); })]);
      } finally {
        closed = true;
        clearTimeout(timer);
        queue.close();
      }
    }
  };
}
