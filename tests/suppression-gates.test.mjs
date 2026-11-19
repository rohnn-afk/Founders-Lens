// Security policy tests. Synthetic evidence exercises the suppression gate,
// which requires fresh clearance before protected work can proceed.

import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { requireClearance, suppressionScopeKey } from '../apps/api/dist/security/suppression-authority.js';
import { unavailableSuppressionAuthority } from '../apps/api/dist/security/suppression-unavailable.js';
import { IdentityService } from '../apps/api/dist/security/identity-service.js';
import { SubjectKeys } from '../apps/api/dist/security/subject-key.js';
import { authorizeIdea } from '../apps/api/dist/security/authorization.js';

const scope = Object.freeze({ kind: 'ACCOUNT', instanceId: 'ins_synthetic', subjectKeyVersion: 1,
  subjectKey: 'a'.repeat(64), incarnation: 'ALL' });
// The nonce ties a reply to one lookup. This fixture mirrors the expected
// shape to test validation without providing real independent evidence.
function clearEvidence(scope, query) {
  return { verdict: 'CLEAR', scope: suppressionScopeKey(scope), nonce: query.nonce,
    observedAt: Date.now(), validUntil: Date.now() + 1000, integrity: 'VERIFIED', coverage: 'COMPLETE',
    authority: 'INDEPENDENT', epoch: 'synthetic-test-only' };
}

test('runtime authority is unavailable and has no positive-clearance configuration', async () => {
  await assert.rejects(requireClearance(unavailableSuppressionAuthority(), scope), { code: 'DEPENDENCY_UNAVAILABLE' });
});

test('missing, stale, corrupt, incomplete and unreachable evidence all deny', async t => {
  for (const [name, mutate] of [
    ['missing', () => null], ['empty', () => ({})],
    ['stale observation', evidence => ({ ...evidence, observedAt: 0 })],
    ['expired', evidence => ({ ...evidence, validUntil: 0 })],
    ['future observation', evidence => ({ ...evidence, observedAt: Date.now() + 60_000 })],
    ['wrong nonce', evidence => ({ ...evidence, nonce: 'old-request' })],
    ['wrong scope', evidence => ({ ...evidence, scope: 'foreign' })],
    ['corrupt integrity', evidence => ({ ...evidence, integrity: 'CORRUPT' })],
    ['incomplete coverage', evidence => ({ ...evidence, coverage: 'PARTIAL' })],
    ['primary database authority', evidence => ({ ...evidence, authority: 'POSTGRES' })],
    ['same-host authority', evidence => ({ ...evidence, authority: 'LOCAL_FIXTURE' })],
    ['no epoch', evidence => ({ ...evidence, epoch: '' })],
    ['suppressed', evidence => ({ ...evidence, verdict: 'SUPPRESSED' })],
    ['unknown state', evidence => ({ ...evidence, verdict: 'UNKNOWN' })]
  ]) await t.test(name, async () => {
    await assert.rejects(requireClearance({ async lookup(s, q) { return mutate(clearEvidence(s, q)); } }, scope), { code: 'DEPENDENCY_UNAVAILABLE' });
  });
  await t.test('unreachable', async () => {
    await assert.rejects(requireClearance({ async lookup() { throw new Error('private dependency details'); } }, scope), { code: 'DEPENDENCY_UNAVAILABLE' });
  });
});

test('a prior clear response cannot authorize a later request or scope', async () => {
  let cached, calls = 0;
  const authority = { async lookup(s, q) { calls++; cached ??= clearEvidence(s, q); return cached; } };
  await requireClearance(authority, scope);
  await assert.rejects(requireClearance(authority, scope), { code: 'DEPENDENCY_UNAVAILABLE' });
  await assert.rejects(requireClearance(authority, { ...scope, subjectKey: 'b'.repeat(64) }), { code: 'DEPENDENCY_UNAVAILABLE' });
  assert.equal(calls, 3);
});

test('identity denial occurs before provider or repository effects', async () => {
  let effects = 0;
  const service = new IdentityService('ins_synthetic', new SubjectKeys(1, new Map([[1, randomBytes(32)]])),
    { async assertLive() { effects++; } }, { async resolve() { effects++; return { id: 'never', status: 'ACTIVE' }; } }, unavailableSuppressionAuthority());
  await assert.rejects(service.resolve({ instanceId: 'ins_synthetic', subject: 'user_synthetic', sessionId: 'sess_synthetic', expiresAt: Date.now() + 60_000 }, 'synthetic-request'), { code: 'DEPENDENCY_UNAVAILABLE' });
  assert.equal(effects, 0);
});

test('clearance is obtained again after provider I/O; missing second evidence prevents provisioning', async () => {
  let lookups = 0, writes = 0;
  const service = new IdentityService('ins_synthetic', new SubjectKeys(1, new Map([[1, randomBytes(32)]])),
    { async assertLive() {} }, { async resolve() { writes++; return { id: 'never', status: 'ACTIVE' }; } },
    { async lookup(s, q) { return ++lookups === 1 ? clearEvidence(s, q) : null; } });
  await assert.rejects(service.resolve({ instanceId: 'ins_synthetic', subject: 'user_synthetic', sessionId: 'sess_synthetic', expiresAt: Date.now() + 60_000 }, 'synthetic-request'), { code: 'DEPENDENCY_UNAVAILABLE' });
  assert.equal(lookups, 2); assert.equal(writes, 0);
});

test('idea authorization cannot bypass unavailable account/idea evidence', async () => {
  const principal = { localUserId: 'synthetic-owner', clerkInstanceId: 'ins_synthetic', accountStatus: 'ACTIVE', subjectKeys: [{ version: 1, digest: scope.subjectKey }] };
  await assert.rejects(authorizeIdea(principal, { id: 'synthetic-idea', ownerId: principal.localUserId, status: 'ACTIVE' }, unavailableSuppressionAuthority()), { code: 'DEPENDENCY_UNAVAILABLE' });
});
