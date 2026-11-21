// Deterministic worker and projection tests. Inject the reader and clock so
// rejection and revocation timing can be checked without services or sleeps.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { assembleGenerationContext, syntheticContextResponse } from '../apps/worker/dist/generation-context.js';
import { generationWorker } from '../apps/worker/dist/generation-worker.js';

const source = (text, truncated = false) => ({ id: randomUUID(), text, truncated });
const projection = () => ({
  current: source('Correction: clinics'),
  previous: [
    { user: source('First hypothesis') },
    { user: source('Second hypothesis'), assistant: source('Selected answer') }
  ],
  memory: [{ ...source('Confirmed channel'), version: 1 }]
});
const assemble = (value, trigger = value.current.id) => assembleGenerationContext(async () => value, trigger);

test('bounded projection preserves current, ordered prior turns, selected answer and version provenance', async () => {
  const value = projection();
  value.previous[1].unselected = source('Excluded variant');
  value.pendingMemory = [source('Excluded proposal')];
  const result = await assemble(value);
  assert.deepEqual(result.current, value.current);
  assert.deepEqual(result.previous, [
    value.previous[0], { user: value.previous[1].user, assistant: value.previous[1].assistant }
  ]);
  assert.deepEqual(result.memory, value.memory);
  assert.equal(await assemble(value, randomUUID()), undefined);
});

test('projection verifies Unicode character and count bounds and rejects malformed content', async () => {
  const value = projection();
  value.current.text = '🧪'.repeat(1200);
  value.current.truncated = true;
  const context = await assemble(value);
  assert.equal(context.current.truncated, true);
  assert.match(await syntheticContextResponse(context), /…/);
  value.current.text += 'x';
  assert.equal(await assemble(value), undefined);
  value.current.text = 'ok';
  value.previous[0].user.text = 'x'.repeat(601);
  assert.equal(await assemble(value), undefined);
  value.previous[0].user.text = 'ok';
  value.memory[0].text = 'x'.repeat(401);
  assert.equal(await assemble(value), undefined);
  value.memory[0].text = 'ok';
  value.previous.push(value.previous[0], value.previous[1]);
  assert.equal(await assemble(value), undefined);
  assert.equal(await assemble({ ...projection(), current: { ...value.current, text: '\0' } }), undefined);
});

test('equivalent approved inputs produce the same response and a correction takes precedence', async () => {
  const value = projection();
  const context = await assemble(value);
  const initial = await syntheticContextResponse(context);
  assert.equal(await syntheticContextResponse(structuredClone(context)), initial);
  value.current.text = 'Correction: mobile clinics only';
  const corrected = await syntheticContextResponse(await assemble(value));
  assert.notEqual(corrected, initial);
  assert.match(corrected, /^Synthetic assistant\. Current founder statement: .*mobile clinics only/);
});

function coordinator({ denyIdeaDuringRead = false, blockedFence = false, expireDuringRead = false } = {}) {
  const value = projection();
  const scope = { id: randomUUID(), triggerMessageId: value.current.id, accountId: randomUUID(),
    ideaId: randomUUID(), contextEpoch: 2, instanceId: 'synthetic', subjectKeyVersion: 1, subjectKey: 'test' };
  let clock = 1000, checks = 0, reads = 0, marks = 0, invocations = 0, recorded = 0;
  const repository = {
    scope: async () => scope,
    claim: async () => ({ epoch: 7, remainingMs: 10_000 }),
    readContext: async (attempt, epoch, expiry) => {
      assert.equal(attempt, scope);
      assert.equal(epoch, 7);
      reads++;
      if (expireDuringRead) clock = expiry;
      if (!blockedFence && clock < expiry) return value;
    },
    markInvocation: async () => { marks++; return true; },
    recordUsage: async () => { recorded++; return true; },
    finish: async () => {}
  };
  const worker = generationWorker(repository, async (key, query) => {
    checks++;
    if (denyIdeaDuringRead && checks === 4) return null;
    return { scope: key, nonce: query.nonce, verdict: 'CLEAR', observedAt: clock, validUntil: clock + 10 };
  }, id => id === scope.id, undefined, () => clock, async context => {
    invocations++;
    return syntheticContextResponse(context);
  });
  return {
    execute: () => worker.process({ name: 'generation.requested', id: scope.id, data: { generationId: scope.id } }),
    counts: () => ({ reads, marks, invocations, recorded })
  };
}

test('independent clearance precedes the read and is renewed before invocation', async () => {
  const allowed = coordinator();
  await allowed.execute();
  assert.deepEqual(allowed.counts(), { reads: 1, marks: 1, invocations: 1, recorded: 1 });
  const denied = coordinator({ denyIdeaDuringRead: true });
  await denied.execute();
  assert.deepEqual(denied.counts(), { reads: 0, marks: 0, invocations: 0, recorded: 0 });
});

test('a rejected SQL fence or clearance expiry during the read prevents invocation', async () => {
  for (const scenario of [{ blockedFence: true }, { expireDuringRead: true }]) {
    const worker = coordinator(scenario);
    await worker.execute();
    assert.deepEqual(worker.counts(), { reads: 1, marks: 0, invocations: 0, recorded: 0 });
  }
});
