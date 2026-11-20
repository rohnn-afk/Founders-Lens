// Validates the isolated test composition before any database or broker connection.
export const policy = Object.freeze({
  batch: 4, pollMs: 250, leaseMs: 15_000, enqueueMs: 1_000,
  attempts: 5, initialDelayMs: 250, maxDelayMs: 2_000,
  windowMs: 120_000, shutdownMs: 5_000, retention: { age: 600, count: 100 }
});
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const run = 'ffb11ac8-505a-4094-bd89-8367450022e9';

export function testTargets(environment: Record<string, string | undefined>) {
  function target(value: string | undefined, protocol: string, port: string, role: string, path: string, query: string) {
    let url: URL;
    try { url = new URL(value ?? ''); } catch { throw new Error('Invalid isolated M05 target'); }
    if (url.protocol !== protocol || url.hostname !== '127.0.0.1' || url.port !== port ||
      url.username !== role || url.pathname !== path || url.search !== query || url.hash ||
      !/^[0-9a-f]{64}$/.test(url.password)) throw new Error('Invalid isolated M05 target');
    return url;
  }
  const prefix = 'founders-lens-m05-test-' + run;
  if (environment['M05_RUN_ID'] !== run || environment['M05_REDIS_PREFIX'] !== prefix) {
    throw new Error('Unexpected isolated M05 run');
  }
  const path = '/founders_lens_m05_test';
  const dispatcher = target(environment['M05_TEST_DATABASE_URL'], 'postgresql:', '55433', 'fl_m05_dispatcher', path, '?schema=public');
  const fixture = target(environment['M05_FIXTURE_DATABASE_URL'], 'postgresql:', '55433', 'fl_m05_fixture', path, '?schema=public');
  const redis = target(environment['M05_REDIS_URL'], 'redis:', '56380', '', '/0', '');
  if (new Set([dispatcher.password, fixture.password, redis.password]).size !== 3) throw new Error('M05 credentials must be distinct');
  return { dispatcher, fixture, redis, prefix };
}
