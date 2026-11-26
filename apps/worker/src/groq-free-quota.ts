import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import type { FreeGroqPolicy } from './groq-free-policy.js';

// Rolling windows share one organization key across the two models.
const reserve = `
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
if redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - 86400000)
local entries = redis.call('ZRANGE', KEYS[1], 0, -1, 'WITHSCORES')
local dailyTokens, minuteTokens, minuteRequests = 0, 0, 0
local amount = tonumber(ARGV[1])
for i=1,#entries,2 do
  local tokens = tonumber(string.match(entries[i], ':(%d+)$'))
  dailyTokens = dailyTokens + tokens
  if tonumber(entries[i+1]) > now - 60000 then
    minuteTokens = minuteTokens + tokens
    minuteRequests = minuteRequests + 1
  end
end
if #entries / 2 >= tonumber(ARGV[2]) or minuteRequests >= tonumber(ARGV[3])
  or dailyTokens + amount > tonumber(ARGV[4]) or minuteTokens + amount > tonumber(ARGV[5]) then return 0 end
redis.call('SET', KEYS[2], ARGV[6], 'PX', 30000)
redis.call('ZADD', KEYS[1], now, ARGV[6] .. ':' .. amount)
redis.call('PEXPIRE', KEYS[1], 86400000)
return 1`;

const settle = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
local original = ARGV[1] .. ':' .. ARGV[2]
local score = redis.call('ZSCORE', KEYS[1], original)
if score and ARGV[3] ~= '' then
  redis.call('ZADD', KEYS[1], score, ARGV[1] .. ':' .. ARGV[3])
  if ARGV[2] ~= ARGV[3] then redis.call('ZREM', KEYS[1], original) end
end
if tonumber(ARGV[4]) > 0 then redis.call('SET', KEYS[3], '1', 'PX', ARGV[4]) end
if ARGV[3] ~= '' then redis.call('DEL', KEYS[2]) end
return 1`;

export function groqFreeQuota(redis: Pick<Redis, 'eval'>, organization: string, policy: FreeGroqPolicy) {
  if (!/^[a-f0-9]{64}$/.test(organization)) throw new Error('Invalid Groq organization scope');
  const prefix = 'founders-lens:groq-free:{' + organization + '}';
  const keys = [prefix + ':usage', prefix + ':active', prefix + ':cooldown'];
  const amount = policy.inputTokens + policy.completionTokens;
  return {
    async reserve() {
      const id = randomUUID();
      const { rpd, rpm, tpd, tpm } = policy.limits;
      if (await redis.eval(reserve, keys.length, ...keys, amount, rpd, rpm, tpd, tpm, id) !== 1) {
        throw new Error('Groq Free quota is currently unavailable');
      }
      return async (used?: number, retryAfterMs = 0) => {
        const actual = used !== undefined && Number.isSafeInteger(used) && used >= 0 ? used : '';
        const cooldown = Number.isSafeInteger(retryAfterMs) ? Math.max(0, Math.min(86400000, retryAfterMs)) : 0;
        if (await redis.eval(settle, keys.length, ...keys, id, amount, actual, cooldown) !== 1) {
          throw new Error('Groq Free reservation could not be settled');
        }
      };
    }
  };
}

export async function openGroqFreeQuota(broker: URL, organization: string, policy: FreeGroqPolicy) {
  if (broker.protocol !== 'redis:' || broker.hostname !== '127.0.0.1' || !broker.port || broker.pathname !== '/0' ||
    broker.username || !/^[a-f0-9]{64}$/.test(broker.password) || broker.hash || broker.search) {
    throw new Error('Isolated Redis required for Groq Free');
  }
  const redis = new Redis(broker.href, { enableOfflineQueue: false, lazyConnect: true, maxRetriesPerRequest: 0,
    connectTimeout: 1500, commandTimeout: 1500, retryStrategy: () => null });
  redis.on('error', () => {});
  try {
    await redis.connect();
    for (const [setting, expected] of [['appendonly', 'yes'], ['appendfsync', 'always'], ['maxmemory-policy', 'noeviction']] as const) {
      const value = await redis.config('GET', setting);
      if (value[1] !== expected) throw new Error('Persistent Groq Free quota storage required');
    }
    return { quota: groqFreeQuota(redis, organization, policy), close: () => redis.disconnect() };
  } catch (error) {
    redis.disconnect();
    throw error;
  }
}
