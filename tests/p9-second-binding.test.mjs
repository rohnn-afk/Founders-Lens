import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { bindSecondP9Scope, cedarDeskHash, cedarDeskPrompt, harborCartHash, harborCartPrompt, readFirstExperiment, readSecondScope,
  secondBindingSubject } from './fixtures/p9-second-binding.mjs';

const identity = { instanceId: 'fixture-instance', subject: 'user_second_fixture' };
const first = { FL_P9_SYNTHETIC_ACCOUNT: 'first-account', FL_P9_SYNTHETIC_CONVERSATION: 'first-conversation' };

test('second binding requires explicit approval and refuses the configured first subject', () => {
  const env = { FL_P9_SECOND_BIND_CONFIRM: 'approve-p9-second-dedicated-clerk-binding',
    FL_P9_SECOND_CLERK_TEST_USER_ID: identity.subject, FL_P9_CLERK_TEST_USER_ID: 'user_first_fixture' };
  assert.equal(secondBindingSubject(env), identity.subject);
  assert.equal(secondBindingSubject({ ...env, CLERK_TEST_USER_ID: identity.subject }), identity.subject);
  assert.throws(() => secondBindingSubject({ ...env, FL_P9_SECOND_BIND_CONFIRM: undefined }));
  assert.throws(() => secondBindingSubject({ ...env, FL_P9_SECOND_CLERK_TEST_USER_ID: env.FL_P9_CLERK_TEST_USER_ID }));
});

test('second binding fails before writes on the wrong target or unverified genesis', async () => {
  const resolve = () => assert.fail('Provisioning must be unreachable');
  await assert.rejects(bindSecondP9Scope({ isolated: false }, identity, resolve), /isolated P9 target/);
  await assert.rejects(bindSecondP9Scope({ isolated: true, verify: async () => { throw Error('Genesis unavailable'); } },
    identity, resolve), /Genesis unavailable/);
});

test('historical guard denies reuse of the actual owner and requires the unresolved attempt', async () => {
  const state = { same_subject: false, receipts: 0, assistants: 0 };
  const primary = { query: async (sql, params) => {
    assert.match(sql, /^SELECT/);
    assert.match(sql, /PROVIDER_OUTCOME_UNKNOWN/);
    assert.match(sql, /"dispatchAuthorizedAt" IS NOT NULL/);
    assert.match(sql, /"reservationState"='RESERVED'/);
    assert.deepEqual(params, ['first-account', 'first-conversation', identity.instanceId, identity.subject]);
    return { rows: [state] };
  } };
  assert.equal(await readFirstExperiment(primary, first, identity), state);
  state.same_subject = true;
  await assert.rejects(readFirstExperiment(primary, first, identity), /different Clerk subject/);
  state.same_subject = false;
  state.receipts = 1;
  await assert.rejects(readFirstExperiment(primary, first, identity), /must be preserved/);
});

test('second scope requires exact ownership and rejects accounts with generation history', async () => {
  const state = { account: 'second-account', verified: true, ideas: 1, conversations: 1, conversation: 'owned',
    messages: false, attempts: false, usage: false, admissions: false };
  const digest = { version: 1, digest: 'fixture-digest' };
  const primary = { query: async (sql, params) => {
    assert.match(sql, /^SELECT/);
    assert.match(sql, /"ownerId"=a.id AND i.title=\$5/);
    assert.deepEqual(params, [identity.instanceId, identity.subject, digest.version, digest.digest, 'Harbor Cart']);
    return { rows: [state] };
  } };
  assert.equal((await readSecondScope(primary, identity, digest)).conversation, 'owned');
  await assert.rejects(readSecondScope(primary, identity, digest, { requireUnbound: true }), /already bound/);
  state.attempts = true;
  await assert.rejects(readSecondScope(primary, identity, digest), /unused/);
  state.attempts = false;
  state.conversation = null;
  await assert.rejects(readSecondScope(primary, identity, digest), /expected fixture/);
});

test('Harbor Cart approval hashes exact UTF-8 bytes without a trailing newline', () => {
  const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
  assert.equal(hash(harborCartPrompt), harborCartHash);
  assert.notEqual(hash(harborCartPrompt + '\n'), harborCartHash);
  assert.equal(hash(cedarDeskPrompt), cedarDeskHash);
  assert.notEqual(hash(cedarDeskPrompt + '\n'), cedarDeskHash);
});
