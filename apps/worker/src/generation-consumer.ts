// BullMQ transport for the explicitly composed T02 fixture worker. Normal
// process startup never imports this module or creates a consumer.
import { Worker, createIORedisClient } from 'bullmq';
import { Redis } from 'ioredis';
import type { generationWorker } from './generation-worker.js';

export function generationConsumer(redisUrl: URL, prefix: string, worker: ReturnType<typeof generationWorker>,
  profile: boolean | 'cedar' | 'cedar-recheck' = false) {
  const legacy = redisUrl.port === '56380' && prefix === 'founders-lens-m05-t02-test-c4493052-1f5e-4060-8e40-700e374c3946';
  const integration = redisUrl.port === (profile === 'cedar-recheck' ? '56384' : profile === 'cedar' ? '56383' : profile ? '56382' : '56381') &&
    /^founders-lens-(?:m05-e2e|p9-local)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(prefix);
  if (redisUrl.protocol !== 'redis:' || redisUrl.hostname !== '127.0.0.1' || (!legacy && !integration) ||
    redisUrl.pathname !== '/0' || redisUrl.username || redisUrl.search || redisUrl.hash ||
    !/^[0-9a-f]{64}$/.test(redisUrl.password)) {
    throw new Error('Unexpected isolated generation broker');
  }
  const redis = new Redis(redisUrl.toString(), { maxRetriesPerRequest: null });
  redis.on('error', () => {});
  const consumer = new Worker('generation', job => worker.process(job), {
    prefix, connection: createIORedisClient(redis), concurrency: 1
  });
  consumer.on('error', () => {});

  return {
    waitUntilReady: () => consumer.waitUntilReady(),
    async close() {
      worker.stop();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([consumer.close(),
          new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); })]);
      } finally { clearTimeout(timer); redis.disconnect(); }
    }
  };
}
