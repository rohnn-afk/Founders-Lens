import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { localGenerationPolicy } from '../apps/api/dist/generation/local-policy.js';

const content = 'Synthetic: a clinic booking exercise.';
const config = { model: 'gemini-3.1-flash-lite', priceVersion: 'v1:offline-pricing-fixture',
  maximumMicrosPerMillionTokens: '1500000', budgetMicros: '7500', tokenBudget: '9000',
  requestsPerMinute: '2', maximumAdmissions: '1', accountId: randomUUID(), conversationId: randomUUID(),
  syntheticTextSha256: createHash('sha256').update(content).digest('hex') };

test('a conservative tariff caps reserved tokens and binds synthetic admission to exact scope and content', () => {
  const { policy, allows } = localGenerationPolicy(config);
  assert.equal(policy.quotaUnits, 5000);
  assert.equal(policy.reservationUnits, 4608);
  assert.equal(policy.maximumAdmissions, 1);
  assert.equal(allows(config.accountId, config.conversationId, content), true);
  assert.equal(allows(randomUUID(), config.conversationId, content), false);
  assert.equal(allows(config.accountId, randomUUID(), content), false);
  assert.equal(allows(config.accountId, config.conversationId, content + ' altered'), false);
});

test('missing, zero, unsupported and insufficient tariffs fail closed', () => {
  for (const changes of [{ priceVersion: undefined }, { maximumMicrosPerMillionTokens: '0' },
    { maximumMicrosPerMillionTokens: '1499999' },
    { model: 'unapproved' }, { budgetMicros: '1' }, { maximumAdmissions: '101' }]) {
    assert.throws(() => localGenerationPolicy({ ...config, ...changes }));
  }
});
