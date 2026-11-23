// Deterministic coordinator tests exercise the authority and lease boundaries
// without a broker, database, or provider.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { generationId, generationWorker } from '../apps/worker/dist/generation-worker.js';
import { founderPrompt } from '../apps/worker/dist/founder-provider.js';
import { groqFounderProvider } from '../apps/worker/dist/groq-provider.js';

const id = randomUUID();
const job = { id, name: 'generation.requested', data: { generationId: id } };
const scope = { id, accountId: randomUUID(), ideaId: randomUUID(), contextEpoch: 2,
  instanceId: 'synthetic', subjectKey: 'a'.repeat(64), subjectKeyVersion: 1 };
const proof = (scope, query) => ({ scope, nonce: query.nonce, verdict: 'CLEAR', observedAt: 10, validUntil: 100 });

function harness(authority = proof, options = {}) {
  const calls = [];
  let claimed = false;
  const repository = {
    scope: async () => scope,
    async claim(_scope, recover) {
      if (claimed && !recover) return;
      claimed = true;
      return { epoch: recover ? 8 : 7, remainingMs: options.remainingMs ?? 5000 };
    },
    async markInvocation(_scope, epoch) {
      calls.push(['start', epoch]);
      options.duringMark?.();
      return !options.cancelled;
    },
    async heartbeat(_scope, epoch) { calls.push(['heartbeat', epoch]); return false; },
    async recordUsage(_scope, epoch) { calls.push(['receipt', epoch]); return true; },
    async finish(_scope, epoch, response) { calls.push(['finish', epoch, response?.text]); }
  };
  const worker = generationWorker(repository, async (...args) => authority(...args), value => value === id,
    options.fake ?? (async () => 'fixed'), options.now ?? (() => 10));
  return { worker, calls };
}

test('generation jobs must identify one exact generation and carry no content', () => {
  assert.equal(generationId(job), id);
  for (const invalid of [{ ...job, id: 'broken' }, { ...job, name: 'generation.other' },
    { ...job, data: { generationId: randomUUID() } }, { ...job, data: { ...job.data, text: 'private' } }]) {
    assert.throws(() => generationId(invalid), /Invalid generation job/);
  }
});

test('duplicate delivery does not invoke or finish twice', async () => {
  const { worker, calls } = harness();
  await Promise.all([worker.process(job), worker.process(job)]);
  assert.deepEqual(calls, [['start', 7], ['receipt', 7], ['finish', 7, 'fixed']]);
});

test('a metered Groq truncation passes usage to settlement once and never publishes partial text', async () => {
  const current = { ...scope, triggerMessageId: randomUUID() };
  const receipts = [], finalizations = [], events = [];
  let claimed = false, calls = 0;
  const provider = groqFounderProvider('gsk_' + 'offline_synthetic_fixture', async () => {
    calls++;
    return Response.json({ id: 'chatcmpl-fixture', choices: [
      { finish_reason: 'length', message: { role: 'assistant', content: 'Partial' } }
    ], usage: { prompt_tokens: 273, completion_tokens: 1024, total_tokens: 1297 } });
  }, event => events.push(event));
  const repository = {
    scope: async () => current,
    async claim() {
      if (claimed) return;
      claimed = true;
      return { epoch: 7, remainingMs: 5000 };
    },
    markInvocation: async () => true,
    heartbeat: async () => true,
    async recordUsage(_scope, epoch, result) { receipts.push({ epoch, usage: result.usage }); return true; },
    async finish(_scope, _epoch, response) { finalizations.push(response); }
  };
  const worker = generationWorker(repository, () => assert.fail('Fixture proof must not be used'),
    value => value === id, undefined, () => 10,
    (context, signal) => provider.generate(founderPrompt(context), signal), {
      verifyExecution: async () => 100,
      readContext: async () => ({ current: { id: current.triggerMessageId, text: 'Synthetic', truncated: false },
        previous: [], memory: [] })
    });
  await Promise.all([worker.process(job), worker.process(job)]);
  assert.equal(calls, 1);
  assert.deepEqual(events, ['GROQ_COMPLETION_TRUNCATED']);
  assert.deepEqual(receipts, [{ epoch: 7, usage: { inputTokens: 273, outputTokens: 1024, totalTokens: 1297 } }]);
  assert.deepEqual(finalizations, [null]);
});

test('expiry of either scope during markInvocation prevents fake execution', async () => {
  for (const firstToExpire of ['ACCOUNT', 'IDEA']) {
    let current = 10;
    let invocations = 0;
    const { worker, calls } = harness((scope, query) => ({
      ...proof(scope, query),
      observedAt: current,
      validUntil: JSON.parse(scope)[0] === firstToExpire ? 100 : 200
    }), {
      now: () => current,
      duringMark: () => { current = 100; },
      fake: async () => { invocations++; return 'unexpected'; }
    });
    await worker.process(job);
    assert.equal(invocations, 0);
    assert.deepEqual(calls, [['start', 7]]);
  }
});

test('missing, denied, expired, mismatched and unavailable evidence fail closed', async () => {
  for (const authority of [() => null, (...args) => ({ ...proof(...args), verdict: 'SUPPRESSED' }),
    (...args) => ({ ...proof(...args), validUntil: 10 }), (...args) => ({ ...proof(...args), nonce: 'old' }),
    () => { throw new Error('unavailable'); }]) {
    const { worker, calls } = harness(authority);
    await worker.process(job);
    assert.deepEqual(calls, []);
  }
});

test('cancelled checkpoint does not invoke the fake, and finalization requires fresh evidence', async () => {
  const cancelled = harness(proof, { cancelled: true });
  await cancelled.worker.process(job);
  assert.deepEqual(cancelled.calls, [['start', 7], ['finish', 7, undefined]]);
  let requests = 0;
  const expired = harness((...args) => ++requests < 5 ? proof(...args) : null);
  await expired.worker.process(job);
  assert.deepEqual(expired.calls, [['start', 7], ['receipt', 7]]);
});

test('fake timeout interrupts work and recovery passes a fresh epoch', async () => {
  const { worker, calls } = harness(proof, { remainingMs: 50, fake: () => new Promise(() => {}) });
  await worker.process(job);
  await worker.recover([id]);
  assert.deepEqual(calls, [['start', 7], ['finish', 7, undefined], ['start', 8], ['finish', 8, undefined]]);
  await assert.rejects(worker.recover([id, id]), /exact fixture IDs/);
  await assert.rejects(worker.recover([randomUUID()]), /exact fixture IDs/);
});

test('failed heartbeat aborts the current fake and prevents output', async () => {
  const { worker, calls } = harness(proof, { fake: () => new Promise(() => {}) });
  await worker.process(job);
  assert.deepEqual(calls, [['start', 7], ['heartbeat', 7], ['finish', 7, undefined]]);
});

test('trusted worker denies invocation after a failed post-marker authority check', async () => {
  const current = { ...scope, triggerMessageId: randomUUID() };
  let checks = 0;
  const repository = {
    scope: async () => current,
    claim: async () => ({ epoch: 7, remainingMs: 5000 }),
    markInvocation: async () => true,
    readContext: () => assert.fail('fixture context must not be used'),
    heartbeat: () => assert.fail('denied invocation cannot renew the lease'),
    finish: () => assert.fail('denied invocation cannot publish')
  };
  const worker = generationWorker(repository, () => assert.fail('fixture proof must not be used'),
    value => value === id, undefined, () => 10, () => assert.fail('denied provider call'), {
      async verifyExecution() {
        if (++checks === 4) throw new Error('Authority unavailable');
        return 100;
      },
      async readContext(actual, lease) {
        assert.equal(actual, current);
        assert.equal(lease.epoch, 7);
        return { current: { id: current.triggerMessageId, text: 'Synthetic', truncated: false }, previous: [], memory: [] };
      }
    });
  await worker.process(job);
  assert.equal(checks, 4);
});
