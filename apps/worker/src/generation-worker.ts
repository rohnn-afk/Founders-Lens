// Isolated worker coordinator. It validates scoped synthetic evidence, bounds
// fake execution, and hands durable transitions to the PostgreSQL adapter.
import { randomUUID } from 'node:crypto';
import { assembleGenerationContext, offlineAssistantContent, type GenerationContext, type OfflineAssistantContent } from './generation-context.js';
import type { Repository, Scope } from './generation-repository.js';
import type { ProviderResult } from './founder-provider.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
type Authority = (scope: string, query: { nonce: string; requestedAt: number }) => Promise<{
  scope: string; nonce: string; verdict: string; observedAt: number; validUntil: number;
} | null>;

export function generationId(job: { id?: string; name: string; data: unknown }) {
  const data = job.data;
  if (job.name !== 'generation.requested' || !job.id || !uuid.test(job.id) || !data ||
    typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 1 ||
    !('generationId' in data) || data.generationId !== job.id) throw new Error('Invalid generation job');
  return job.id;
}

export function generationWorker(repository: Repository, authority: Authority, allowed: (id: string) => boolean,
  fake: (signal: AbortSignal) => Promise<string> = async () => 'This is a deterministic test response.',
  now = Date.now, contextResponse?: (context: GenerationContext, signal: AbortSignal) => Promise<string | ProviderResult>,
  trusted?: {
    structuredOffline?: boolean;
    verifyExecution(scope: Scope): Promise<number>;
    readContext(scope: Scope, lease: { epoch: number }): Promise<unknown>;
  }) {
  if (trusted && !contextResponse) throw new Error('Trusted generation requires a context provider');
  let recovering = false;
  const running = new Set<AbortController>();
  let stopping = false;

  async function clearance(scope: Scope) {
    if (trusted) {
      const deadline = await trusted.verifyExecution(scope).catch(() => undefined);
      return deadline !== undefined && Number.isSafeInteger(deadline) && deadline > now() ? deadline : undefined;
    }
    let expiry = Infinity;
    for (const key of [
      JSON.stringify(['ACCOUNT', scope.instanceId, scope.subjectKeyVersion, scope.subjectKey, 'ALL']),
      JSON.stringify(['IDEA', scope.instanceId, scope.accountId, scope.ideaId])
    ]) {
      const query = { nonce: randomUUID(), requestedAt: now() };
      const proof = await authority(key, query).catch(() => null);
      if (!proof || proof.scope !== key || proof.nonce !== query.nonce || proof.verdict !== 'CLEAR' ||
        !Number.isFinite(proof.observedAt) || proof.observedAt < query.requestedAt || proof.observedAt > now() ||
        !Number.isSafeInteger(proof.validUntil) || proof.validUntil <= now()) return undefined;
      expiry = Math.min(expiry, proof.validUntil);
    }
    return expiry > now() ? expiry : undefined;
  }

  async function execute(id: string, recover = false) {
    if (!uuid.test(id) || !allowed(id)) throw new Error('Generation outside isolated scope');
    if (stopping) return;
    const scope = await repository.scope(id);
    const claimExpiry = scope && !stopping ? await clearance(scope) : undefined;
    if (!scope || !claimExpiry || stopping) return;
    const started = performance.now();
    const lease = await repository.claim(scope, recover, claimExpiry);
    if (!lease || stopping) return;
    const readExpiry = await clearance(scope);
    const context = contextResponse && readExpiry && !stopping
      ? await assembleGenerationContext(() => trusted ? trusted.readContext(scope, lease)
        : repository.readContext(scope, lease.epoch, readExpiry), scope.triggerMessageId)
      : undefined;
    // Acquire fresh evidence after the bounded projection. The existing
    // invocation fence rechecks the captured context epoch before execution.
    const invocationExpiry = context && !stopping ? await clearance(scope) : readExpiry;
    if (!invocationExpiry || stopping || (contextResponse && !context) || (trusted && context?.memory.length) ||
      !await repository.markInvocation(scope, lease.epoch, invocationExpiry)) {
      const expiry = stopping ? undefined : await clearance(scope);
      if (expiry && !stopping) await repository.finish(scope, lease.epoch, null, expiry);
      return;
    }

    // Recheck after the durable marker, which can wait for primary locks.
    // Failure here leaves the marker conservative and prevents provider I/O.
    const callExpiry = trusted ? await clearance(scope) : invocationExpiry;
    if (!callExpiry || stopping || (trusted && !await repository.heartbeat(scope, lease.epoch))) return;

    const abort = new AbortController();
    running.add(abort);
    let inFlight: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (!inFlight) inFlight = repository.heartbeat(scope, lease.epoch)
        .then(alive => { if (!alive) abort.abort(); }, () => abort.abort())
        .finally(() => { inFlight = undefined; });
    }, 1000);
    const timeoutMs = Math.min(trusted ? 9000 : 3000, lease.remainingMs - (performance.now() - started));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let result: { id: string; text: string; assistantContent?: OfflineAssistantContent } | null = null;
    let observation: ProviderResult | undefined;
    try {
      if (timeoutMs > 0 && !stopping) {
        const interrupted = new Promise<never>((_, reject) => {
          abort.signal.addEventListener('abort', () => reject(new Error('Fake execution interrupted')), { once: true });
        });
        timeout = setTimeout(() => abort.abort(), timeoutMs);
        // Recording invocation can wait for a row lock. Recheck the original
        // evidence immediately before invoking, without an intervening await.
        if (now() < Math.min(invocationExpiry, callExpiry)) {
          const work = contextResponse && context ? contextResponse(context, abort.signal) : fake(abort.signal);
          const response = await Promise.race([work, interrupted]);
          if (typeof response !== 'string') observation = response;
          const text = typeof response === 'string' ? response : response.text;
          if (typeof text === 'string' && text.length > 0 && Array.from(text).length <= 10_000 &&
            text.isWellFormed() && !text.includes('\0')) result = { id: randomUUID(), text,
              ...(trusted?.structuredOffline && context && { assistantContent: offlineAssistantContent(context) }) };
        }
      }
    } catch { /* The repository decides whether the failed fake can be recovered. */ }
    finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      await inFlight;
      running.delete(abort);
    }
    // A known result can outlive permission to publish its content. Persist
    // only the accounting evidence while this worker still owns the lease.
    if ((result || observation?.usage) && !await repository.recordUsage(scope, lease.epoch, observation)) return;
    // Evidence is checked again outside the transaction. The final locked
    // write independently verifies scope, cancellation, context and epoch.
    const finalizationExpiry = stopping ? undefined : await clearance(scope);
    if (finalizationExpiry && !stopping) await repository.finish(scope, lease.epoch, result, finalizationExpiry);
  }

  return {
    async process(job: Parameters<typeof generationId>[0]) {
      const id = generationId(job);
      try { await execute(id); }
      catch { throw new Error('Generation processing unavailable'); }
    },
    async recover(ids: readonly string[]) {
      if (ids.length > 4 || new Set(ids).size !== ids.length || !ids.every(id => uuid.test(id) && allowed(id))) {
        throw new Error('Recovery requires at most four exact fixture IDs');
      }
      if (stopping || recovering) return;
      recovering = true;
      try { for (const id of ids) await execute(id,true); }
      finally { recovering = false; }
    },
    stop() { stopping = true; for (const abort of running) abort.abort(); }
  };
}
