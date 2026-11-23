import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { localGenerationModel, localGenerationPolicy } from '../apps/api/dist/generation/local-policy.js';
import { cedarAcceptanceEnabled, cedarAcceptanceTarget, cedarRecheckTarget } from '../apps/api/dist/generation/cedar-acceptance-target.js';

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

test('Groq uses a distinct reservation and reviewed tariff; invalid model selections fail closed', () => {
  const groq = { ...config, model: 'openai/gpt-oss-20b', priceVersion: 'v1:groq-gpt-oss-20b',
    maximumMicrosPerMillionTokens: '300000', budgetMicros: '1575', tokenBudget: '5248' };
  assert.equal(localGenerationPolicy(groq).policy.reservationUnits, 5248);
  assert.equal(localGenerationPolicy(groq).policy.quotaUnits, 5248);
  for (const change of [{ budgetMicros: '1574' }, { tokenBudget: '4480' },
    { maximumMicrosPerMillionTokens: '299999' }, { priceVersion: config.priceVersion }]) {
    assert.throws(() => localGenerationPolicy({ ...groq, ...change }));
  }
  assert.equal(localGenerationModel({ FL_P9_PROVIDER: 'groq', P9_GROQ_MODEL: groq.model }), groq.model);
  assert.throws(() => localGenerationModel({ FL_P9_PROVIDER: 'groq', P9_GROQ_MODEL: config.model }));
  assert.throws(() => localGenerationModel({ FL_P9_PROVIDER: 'unknown', P9_GEMINI_MODEL: config.model }));
});

test('Cedar acceptance requires an explicit isolated Groq profile on separate fixed targets', () => {
  const env = { FL_P9_CEDAR_ACCEPTANCE: '1', FL_P9_ISOLATED: '1', FL_P9_PROVIDER: 'groq',
    P9_GROQ_MODEL: 'openai/gpt-oss-20b' };
  assert.equal(cedarAcceptanceEnabled({}), false);
  assert.equal(cedarAcceptanceEnabled(env), true);
  assert.equal(cedarAcceptanceEnabled({ ...env, FL_P9_CEDAR_ACCEPTANCE: '2' }), true);
  assert.deepEqual(cedarAcceptanceTarget, {
    primaryPort: 55441, authorityPort: 55442, redisPort: 56383, database: 'founders_lens_cedar_acceptance'
  });
  assert.deepEqual(cedarRecheckTarget, {
    primaryPort: 55443, authorityPort: 55444, redisPort: 56384, database: 'founders_lens_cedar_recheck'
  });
  for (const change of [{ NODE_ENV: 'production' }, { FL_P9_DISPOSABLE: '1' }, { FL_P9_PROVIDER: 'gemini' },
    { FL_P9_ISOLATED: '0' }, { P9_GEMINI_API_KEY: 'fixture' }, { GROQ_API_KEY: 'fixture' }]) {
    assert.throws(() => cedarAcceptanceEnabled({ ...env, ...change }));
  }
});
