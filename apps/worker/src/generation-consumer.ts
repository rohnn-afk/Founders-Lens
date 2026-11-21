// BullMQ transport for the explicitly composed T02 fixture worker. Normal
// process startup never imports this module or creates a consumer.
import { Worker, createIORedisClient } from 'bullmq';
import { Redis } from 'ioredis';
import type { generationWorker } from './generation-worker.js';

export function generationConsumer(redisUrl: URL, prefix: string, worker: ReturnType<typeof generationWorker>) {
  if (redisUrl.protocol !== 'redis:' || redisUrl.hostname !== '127.0.0.1' || redisUrl.port !== '56380' ||
    redisUrl.pathname !== '/0' || redisUrl.username || redisUrl.search || redisUrl.hash ||
    !/^[0-9a-f]{64}$/.test(redisUrl.password) ||
    prefix !== 'founders-lens-m05-t02-test-c4493052-1f5e-4060-8e40-700e374c3946') {
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
