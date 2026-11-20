// BullMQ adapter for opaque generation references. It owns the Redis
// connection and bounds producer waits without interpreting a timeout as rejection.
import { Queue, createIORedisClient } from 'bullmq';
import { Redis } from 'ioredis';
import { isUuid, policy } from './config.js';

export type PublicationWindow = {
  remainingMs: () => number;
  recheck: () => Promise<(() => number) | undefined>;
};
type Broker = Queue<{ generationId: string }, void, 'generation.requested'>;
type Connection = { queue: Pick<Broker, 'waitUntilReady' | 'getJob' | 'add' | 'close'>; disconnect: () => void };

export function generationQueue(url: URL, prefix: string, connect?: () => Connection) {
  function open() {
    if (url.protocol !== 'redis:' || url.hostname !== '127.0.0.1' || url.port !== '56380' ||
      prefix !== 'founders-lens-m05-test-ffb11ac8-505a-4094-bd89-8367450022e9' || url.pathname !== '/0' ||
      url.username || url.hash || url.search || !/^[a-f0-9]{64}$/.test(url.password)) {
      throw new Error('Invalid isolated broker');
    }
    const redis = new Redis(url.toString(), {
      lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0,
      retryStrategy: () => null, autoResendUnfulfilledCommands: false, connectTimeout: policy.enqueueMs
    });
    const queue = new Queue<{ generationId: string }, void, 'generation.requested'>('generation', {
      prefix, connection: createIORedisClient(redis)
    });
    // Raw broker errors may include commands or connection details.
    redis.on('error', () => {});
    queue.on('error', () => {});
    return { queue, disconnect: () => redis.disconnect() };
  }
  let resources: Connection | undefined;
  let closed = false;

  async function use<T>(remainingMs: () => number,
    operation: (queue: Connection['queue'], active: () => boolean, tighten: (ms: number) => void) => Promise<T>) {
    if (closed) throw new Error('Generation queue is closed');
    if (!(remainingMs() > 0)) throw new Error('Broker window ended');
    const end = performance.now() + policy.enqueueMs;
    const current = resources ??= (connect ?? open)();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    let rejectTimeout: (error: Error) => void = () => {};
    const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
    const active = () => !closed && !expired && remainingMs() > 0 && performance.now() < end;
    function tighten(ms: number) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        expired = true;
        rejectTimeout(new Error('Broker deadline'));
      }, Math.max(0, Math.min(end - performance.now(), remainingMs(), ms)));
    }
    tighten(policy.enqueueMs);
    try {
      return await Promise.race([
        current.queue.waitUntilReady().then(() => operation(current.queue, active, tighten)),
        timeout
      ]);
    } catch {
      // Disconnect so a timed-out command cannot be buffered for a later
      // reconnect. Redis may already have accepted it, so retry the same ID.
      resources = undefined;
      current.disconnect();
      void current.queue.close().catch(() => {});
      throw new Error('Broker outcome unavailable');
    } finally { clearTimeout(timer); }
  }

  async function inspect(queue: Connection['queue'], generationId: string, active: () => boolean) {
    if (!active()) throw new Error('Broker window ended');
    const job = await queue.getJob(generationId);
    if (!active()) throw new Error('Broker window ended');
    if (!job) return 'missing';
    if (job.name !== 'generation.requested' || !job.data || Object.keys(job.data).length !== 1 ||
      job.data.generationId !== generationId) return 'mismatch';
    const state = await job.getState();
    if (!active()) throw new Error('Broker window ended');
    if (state === 'unknown') throw new Error('Broker job state unavailable');
    return state === 'failed' ? 'failed' : 'retained';
  }
  return {
    lookup(generationId: string, remainingMs: () => number) {
      if (!isUuid(generationId)) throw new Error('Invalid generation ID');
      return use(remainingMs, (queue, active) => inspect(queue, generationId, active));
    },
    publish(generationId: string, window: PublicationWindow) {
      if (!isUuid(generationId)) throw new Error('Invalid generation ID');
      return use(window.remainingMs, async (queue, active, tighten) => {
        if (!active()) return 'blocked' as const;
        const existing = await inspect(queue, generationId, active);
        if (!active()) return 'blocked' as const;
        // Readiness and lookup can consume the original authorization window.
        // Reauthorize here, with no await between the final check and add.
        // PostgreSQL and Redis cannot commit this check atomically. A worker
        // must independently gate private reads, execution and finalization.
        const remaining = await window.recheck();
        if (!remaining || !active() || remaining() <= 0) return 'blocked' as const;
        if (existing !== 'missing') return existing;
        tighten(remaining());
        if (!active() || remaining() <= 0) return 'blocked' as const;
        // A stable job ID deduplicates retained jobs. PostgreSQL still owns
        // the intent if Redis loses the job or the acknowledgement is lost.
        await queue.add('generation.requested', { generationId }, {
          jobId: generationId, attempts: 1, removeOnComplete: policy.retention, removeOnFail: policy.retention
        });
        return inspect(queue, generationId, () => active() && remaining() > 0);
      });
    },
    close() {
      closed = true;
      resources?.disconnect();
      void resources?.queue.close().catch(() => {});
    }
  };
}
export type GenerationQueue = ReturnType<typeof generationQueue>;
