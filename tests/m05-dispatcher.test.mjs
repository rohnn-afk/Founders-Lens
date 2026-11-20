// Deterministic coordinator tests using in-memory ports and controlled time.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { backoff, dispatcher } from '../apps/dispatcher/dist/dispatch.js';
import { testTargets } from '../apps/dispatcher/dist/config.js';
import { generationQueue } from '../apps/dispatcher/dist/generation-queue.js';

const run = 'ffb11ac8-505a-4094-bd89-8367450022e9';
const configured = {
  M05_RUN_ID: run, M05_REDIS_PREFIX: 'founders-lens-m05-test-' + run,
  M05_TEST_DATABASE_URL: 'postgresql://fl_m05_dispatcher:' + '1'.repeat(64) + '@127.0.0.1:55433/founders_lens_m05_test?schema=public',
  M05_FIXTURE_DATABASE_URL: 'postgresql://fl_m05_fixture:' + '2'.repeat(64) + '@127.0.0.1:55433/founders_lens_m05_test?schema=public',
  M05_REDIS_URL: 'redis://:' + '3'.repeat(64) + '@127.0.0.1:56380/0'
};
const fresh = async (scope, query) => ({
  scope, nonce: query.nonce, verdict: 'CLEAR', observedAt: query.requestedAt, validUntil: query.requestedAt + 2000
});

function setup(overrides = {}) {
  const aggregateId = randomUUID();
  const event = { id: randomUUID(), claimEpoch: 1, dispatchAttempts: 1, kind: 'generation.requested',
    aggregateType: 'GenerationAttempt', aggregateId, payload: { generationId: aggregateId }, ...overrides.event };
  const scope = { accountId: randomUUID(), ideaId: randomUUID(), conversationId: randomUUID(),
    instanceId: 'synthetic', subjectKey: 'opaque', subjectKeyVersion: 1, remainingMs: 2000 };
  const calls = [];
  const repo = {
    async claim() { calls.push('claim'); return { events: [event], exhausted: [] }; },
    async scope() { calls.push('scope'); return overrides.scopeCheck ? overrides.scopeCheck(scope) : scope; },
    async acknowledge() { calls.push('ack'); return true; },
    async fail(_event, code, delay, terminal) { calls.push([code, delay]); return terminal ? 'FAILED' : 'PENDING'; },
    assertFixtures(ids) { assert.deepEqual(ids, [event.id]); },
    async published() { return event; },
    async reclaimPublished() { calls.push('reclaim'); return { ...event, claimEpoch: 2 }; },
    ...overrides.repository
  };
  const queue = {
    async publish(id) { calls.push(['publish', id]); return 'retained'; },
    async lookup() { calls.push('lookup'); return 'missing'; },
    close() { calls.push('close'); },
    ...overrides.queue
  };
  return { event, calls, coordinator: dispatcher(repo, overrides.broker ?? queue, overrides.authority ?? fresh,
    outcome => calls.push(outcome), { now: () => 1000, random: () => 0, ...overrides.clock }) };
}

test('validates exact connection targets, roles and namespace', () => {
  assert.equal(testTargets(configured).redis.port, '56380');
  for (const patch of [
    { M05_RUN_ID: randomUUID() }, { M05_REDIS_PREFIX: 'other' },
    { M05_REDIS_URL: configured.M05_REDIS_URL.replace('56380', '56379') },
    { M05_TEST_DATABASE_URL: configured.M05_TEST_DATABASE_URL.replace('55433', '55432') },
    { M05_FIXTURE_DATABASE_URL: configured.M05_TEST_DATABASE_URL }
  ]) assert.throws(() => testTargets({ ...configured, ...patch }), /isolated M05 target|isolated M05 run/);
  assert.equal(backoff(1, () => 0), 125);
  assert.equal(backoff(4, () => 0.99999), 2000);
  assert.equal(backoff(5, () => 0), 1000);
});

test('broker receives the stable ID after scoped checks and stale acknowledgement is reported', async () => {
  const { coordinator, event, calls } = setup({ repository: { async acknowledge() { return false; } } });
  await coordinator.poll();
  assert.deepEqual(calls, ['claim', 'scope', 'scope', ['publish', event.aggregateId], 'STALE_CLAIM']);
});

test('invalid event and absent, denied, stale or mismatched suppression never reach Redis', async () => {
  const bad = setup({ event: { payload: { generationId: randomUUID() } } });
  await bad.coordinator.poll();
  assert.deepEqual(bad.calls, ['claim', ['INVALID_EVENT', 0], 'FAILED:INVALID_EVENT']);
  for (const authority of [
    async () => null, async () => { throw new Error('unsanitized details'); },
    async (...args) => ({ ...await fresh(...args), verdict: 'SUPPRESSED' }),
    async (...args) => ({ ...await fresh(...args), verdict: 'UNAVAILABLE' }),
    async (...args) => ({ ...await fresh(...args), nonce: randomUUID() }),
    async (...args) => ({ ...await fresh(...args), observedAt: 999 })
  ]) {
    const { coordinator, calls } = setup({ authority });
    await coordinator.poll();
    assert.deepEqual(calls, ['claim', 'scope', ['SUPPRESSION_UNAVAILABLE', 125], 'RETRY:SUPPRESSION_UNAVAILABLE']);
  }
});

test('explicit reconciliation requires a confirmed miss, and closed dispatchers cannot claim', async () => {
  const healthy = setup();
  await healthy.coordinator.reconcile([healthy.event.id]);
  assert.ok(healthy.calls.includes('reclaim'));
  assert.deepEqual(healthy.calls.find(Array.isArray), ['publish', healthy.event.aggregateId]);
  for (const lookup of [async () => 'failed', async () => { throw new Error('offline'); }]) {
    const { coordinator, calls, event } = setup({ queue: { lookup } });
    await coordinator.reconcile([event.id]);
    assert.equal(calls.includes('reclaim'), false);
    await coordinator.close();
    await coordinator.poll();
    assert.equal(calls.includes('claim'), false);
    assert.ok(calls.includes('close'));
  }
  assert.throws(() => healthy.coordinator.reconcile(Array.from({ length: 5 }, randomUUID)), /one to four/);
});

function brokerBoundary({ invalidates, retained = false, loseAck = false } = {}) {
  const { redis, prefix } = testTargets(configured);
  let time = 1000, usable = true, evidenceReads = 0, job;
  let deadline = Infinity;
  const adds = [];
  const simulated = generationQueue(redis, prefix, () => ({
    disconnect() {},
    queue: {
      async waitUntilReady() { if (invalidates === 'deadline') time = deadline; },
      async getJob() {
        if (invalidates === 'suppression') time = 1200;
        if (invalidates === 'lease' || invalidates === 'lifecycle') usable = false;
        if (retained) return { name: 'generation.requested', data: { generationId: event.aggregateId },
          async getState() { return 'waiting'; } };
        return job;
      },
      async add(name, data, options) {
        adds.push({ name, data, id: options.jobId });
        job = { name, data, async getState() { return 'waiting'; } };
        if (loseAck) time = 1300;
      },
      async close() {}
    }
  }));
  const { event, calls, coordinator } = setup({
    broker: simulated,
    clock: { now: () => time, monotonic: () => time },
    scopeCheck: scope => usable && time < deadline
      ? { ...scope, remainingMs: Math.min(2000, deadline - time) }
      : undefined,
    async authority(scope, query) {
      evidenceReads++;
      const short = invalidates === 'suppression' || (loseAck && time < 1300);
      return { ...await fresh(scope, query), validUntil: short ? 1100 : time + 2000 };
    }
  });
  if (invalidates === 'deadline') deadline = 1100;
  return { event, coordinator, calls, adds, evidenceReads: () => evidenceReads };
}

for (const [name, invalidates] of [
  ['generation deadline expires during Redis readiness', 'deadline'],
  ['suppression evidence expires during broker lookup', 'suppression'],
  ['claim lease expires before enqueue', 'lease'],
  ['local lifecycle becomes ineligible before enqueue', 'lifecycle']
]) {
  test(name + ' without sending queue.add', async () => {
    const { coordinator, adds, calls } = brokerBoundary({ invalidates });
    await coordinator.poll();
    assert.deepEqual(adds, []);
    assert.ok(!calls.includes('ack'));
    await coordinator.close();
  });
}

test('retained matching job after a lookup is acknowledged only with current authorization', async () => {
  const expired = brokerBoundary({ retained: true, invalidates: 'suppression' });
  await expired.coordinator.poll();
  assert.deepEqual(expired.adds, []);
  assert.ok(!expired.calls.includes('ack'));
  await expired.coordinator.close();
  const current = brokerBoundary({ retained: true });
  await current.coordinator.poll();
  assert.deepEqual(current.adds, []);
  assert.equal(current.evidenceReads(), 4);
  assert.ok(current.calls.includes('PUBLISHED'));
  await current.coordinator.close();
});

test('an add issued before expiry can be uncertain and recovery confirms the same retained job', async () => {
  const { event, coordinator, calls, adds } = brokerBoundary({ loseAck: true });
  await coordinator.poll();
  assert.deepEqual(adds, [{ name: 'generation.requested',
    data: { generationId: event.aggregateId }, id: event.aggregateId }]);
  assert.ok(calls.includes('RETRY:BROKER_UNCERTAIN'));
  assert.ok(!calls.includes('ack'));
  await coordinator.poll();
  assert.equal(adds.length, 1);
  assert.equal(calls.filter(call => call === 'PUBLISHED').length, 1);
  await coordinator.close();
});
