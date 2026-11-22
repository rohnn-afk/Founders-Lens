import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { verifyExecutionScope } from '../apps/api/dist/generation/execution-scope.js';
import { suppressionScopeKey } from '../apps/api/dist/security/suppression-authority.js';

test('execution references require exact bindings and every retained scope on every check', async () => {
  const accountKey = { version: 1, digest: 'a'.repeat(64) };
  const current = { accountId: randomUUID(), ideaId: randomUUID(), conversationId: randomUUID(),
    instanceId: 'dev', messageId: randomUUID(), generationId: randomUUID(), accountKey };
  const binding = { primaryTarget: '123:1', authorityIdentity: '456:1', namespace: 'synthetic', recoveryRun: randomUUID() };
  const saved = { ...binding, version: 1, accountId: current.accountId, ideaId: current.ideaId,
    conversationId: current.conversationId, instanceId: current.instanceId, messageId: current.messageId,
    generationId: current.generationId, accountKeys: [accountKey, { version: 2, digest: 'b'.repeat(64) }] };
  const decision = { ...binding, epoch: randomUUID(), subjectVersions: [1, 2],
    purpose: 'founders-lens:local-generation:execute', expiresAt: Date.now() + 10_000 };
  const observed = [];
  let denyVersion;
  const authority = { async lookup(scope, { nonce }) {
    observed.push(scope.kind === 'IDEA' ? 'IDEA' : scope.subjectKeyVersion);
    return { scope: suppressionScopeKey(scope), nonce, observedAt: Date.now(),
      validUntil: Date.now() + 1000, authority: 'INDEPENDENT', epoch: decision.epoch,
      coverage: 'COMPLETE', integrity: 'VERIFIED',
      verdict: scope.subjectKeyVersion === denyVersion && scope.kind === 'ACCOUNT' ? 'SUPPRESSED' : 'CLEAR' };
  } };
  const verify = (value, live = decision, actual = current) =>
    verifyExecutionScope(value, actual, authority, async () => live, 'execute');
  await verify(saved);
  assert.deepEqual(observed, [1, 2, 'IDEA']);
  observed.length = 0;
  await assert.rejects(verify(saved, { ...decision, subjectVersions: [1, 2, 3] }));
  await assert.rejects(verify({ ...saved, accountKeys: [accountKey] }));
  await assert.rejects(verify(saved, { ...decision, primaryTarget: '123:2' }));
  await assert.rejects(verify(saved, decision, { ...current, generationId: randomUUID() }));
  await assert.rejects(verify(saved, { ...decision, purpose: 'founders-lens:local-generation:dispatch' }));
  assert.deepEqual(observed, []);
  denyVersion = 2;
  await assert.rejects(verify(saved));
  assert.deepEqual(observed, [1, 2]);
});
