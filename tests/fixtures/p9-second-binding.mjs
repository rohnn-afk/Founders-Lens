import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { seedP9Conversation, verifyP6ProvisioningGrants, withP6Provisioning } from './p6-local-operator.mjs';

export const harborCartPrompt = 'Fictional startup Harbor Cart plans to deliver reusable grocery crates to small neighborhood shops. We assume shop owners will pay monthly for fewer packaging problems. What is the riskiest assumption, and how could we test it cheaply?';
export const harborCartHash = '9b05e9e197efabef646a85842aa7ddc83ba2cab78eab3efa9a40e75b9040095a';
export const cedarDeskPrompt = 'Fictional startup Cedar Desk rents portable standing desks to remote workers. We assume customers will pay a monthly subscription instead of purchasing a desk. What is the riskiest assumption, and how could we validate it with a cheap experiment?';
export const cedarDeskHash = '43c195203b83fad3fa98b33e727abebaa23779f1ceb98442a34d5ff9270bcfcb';

/** Require explicit approval for a Clerk development subject before opening Edge. */
export function secondBindingSubject(env) {
  const subject = env.FL_P9_SECOND_CLERK_TEST_USER_ID;
  assert.ok(env.FL_P9_SECOND_BIND_CONFIRM === 'approve-p9-second-dedicated-clerk-binding' &&
    /^user_[A-Za-z0-9_-]+$/.test(subject ?? '') &&
    subject !== env.FL_P9_CLERK_TEST_USER_ID, 'Eligible second P9 Clerk identity and explicit confirmation required');
  return subject;
}

/** Check the historical scope directly so a lost or incorrect local subject setting cannot authorize reuse. */
export async function readFirstExperiment(primary, first, identity) {
  const { rows } = await primary.query(`SELECT
    (a."clerkInstanceId"=$3 AND a."clerkSubject"=$4) AS same_subject,
    (SELECT count(*)::int FROM public."GenerationProviderReceipt" WHERE "attemptId"=g.id) AS receipts,
    (SELECT count(*)::int FROM public."Message" WHERE "conversationId"=c.id AND role='ASSISTANT') AS assistants,
    md5(row_to_json(a)::text) AS account_snapshot, md5(row_to_json(g)::text) AS attempt_snapshot,
    md5(row_to_json(u)::text) AS reservation_snapshot
    FROM public."UserAccount" a JOIN public."Idea" i ON i."ownerId"=a.id
    JOIN public."Conversation" c ON c."ideaId"=i.id
    JOIN public."GenerationAttempt" g ON g."conversationId"=c.id
    JOIN public."UsageLedger" u ON u."reservationId"=g.id AND u."accountId"=a.id
    WHERE a.id=$1 AND c.id=$2 AND g.status='FAILED' AND g."errorCode"='PROVIDER_OUTCOME_UNKNOWN'
      AND g."dispatchAuthorizedAt" IS NOT NULL AND u."reservationState"='RESERVED' AND u."measuredUnits"=0`,
  [first.FL_P9_SYNTHETIC_ACCOUNT, first.FL_P9_SYNTHETIC_CONVERSATION, identity.instanceId, identity.subject]);
  const [state] = rows;
  assert.ok(rows.length === 1 && state && !state.same_subject && state.receipts === 0 && state.assistants === 0,
    'First P9 experiment must be preserved and owned by a different Clerk subject');
  return state;
}

/** Read only the verified Clerk subject's account, fixture ownership and unused generation allowance. */
export async function readSecondScope(primary, identity, digest, { requireUnbound = false, title = 'Harbor Cart' } = {}) {
  const { rows: [state] } = await primary.query(`SELECT a.id AS account,
    (a.status='ACTIVE' AND a."subjectKeyVersion"=$3 AND a."subjectKey"=$4) AS verified,
    (SELECT count(*)::int FROM public."Idea" WHERE "ownerId"=a.id) AS ideas,
    (SELECT count(*)::int FROM public."Conversation" c JOIN public."Idea" i ON i.id=c."ideaId"
      WHERE i."ownerId"=a.id) AS conversations,
    (SELECT c.id FROM public."Conversation" c JOIN public."Idea" i ON i.id=c."ideaId"
      WHERE i."ownerId"=a.id AND i.title=$5 AND i.status='ACTIVE' AND c.status='ACTIVE'
        AND c."nextSequence"=1 LIMIT 1) AS conversation,
    EXISTS (SELECT FROM public."Message" m JOIN public."Idea" i ON i.id=m."ideaId" WHERE i."ownerId"=a.id) AS messages,
    EXISTS (SELECT FROM public."GenerationAttempt" g JOIN public."Conversation" c ON c.id=g."conversationId"
      JOIN public."Idea" i ON i.id=c."ideaId" WHERE i."ownerId"=a.id) AS attempts,
    EXISTS (SELECT FROM public."UsageLedger" WHERE "accountId"=a.id) AS usage,
    EXISTS (SELECT FROM public."IdempotencyRecord" WHERE "accountId"=a.id) AS admissions
    FROM public."UserAccount" a WHERE a."clerkInstanceId"=$1 AND a."clerkSubject"=$2`,
  [identity.instanceId, identity.subject, digest.version, digest.digest, title]);
  if (!state) return;
  assert.ok(!requireUnbound, 'Chosen Clerk subject is already bound in isolated P9');
  assert.ok(state.verified && !state.messages && !state.attempts && !state.usage && !state.admissions &&
    ((state.ideas === 0 && state.conversations === 0) ||
      (state.ideas === 1 && state.conversations === 1 && state.conversation)),
  'Second P9 account must be active, unused and bound to the expected fixture only');
  return state;
}

/** Provision through the existing maintenance window and write a separate, no-overwrite allowlist. */
export async function bindSecondP9Scope(context, identity, resolve, { cedar = false } = {}) {
  assert.ok(context.isolated, 'Verified isolated P9 target required');
  await context.verify();
  const [title, prompt, hash, output] = cedar
    ? ['Cedar Desk', cedarDeskPrompt, cedarDeskHash, context.recheck ? '.env.p9-cedar-recheck-scope.local' : '.env.p9-cedar-scope.local']
    : ['Harbor Cart', harborCartPrompt, harborCartHash, '.env.p9-second-scope.local'];
  assert.equal(createHash('sha256').update(prompt, 'utf8').digest('hex'), hash);
  assert.ok(!context.cedar || cedar, 'Cedar fixture required on acceptance target');
  const files = context.cedar ? []
    : cedar ? ['.env.p9-scope.local', '.env.p9-second-scope.local'] : ['.env.p9-scope.local'];
  const previous = await Promise.all(files.map(async file => parseEnv(await readFile(file, 'utf8'))));
  const history = () => Promise.all(previous.map(scope => readFirstExperiment(context.primary, scope, identity)));
  const historical = JSON.stringify(await history());
  const [digest] = context.subjectKeys.derive(identity.instanceId, identity.subject);
  const inspect = options => readSecondScope(context.primary, identity, digest, { ...options, title });
  const scopeText = scope => `FL_P9_SYNTHETIC_ACCOUNT=${scope.account}\nFL_P9_SYNTHETIC_CONVERSATION=${scope.conversation}\nFL_P9_SYNTHETIC_TEXT_SHA256=${hash}\n`;
  let existing;
  try { existing = await readFile(output, 'utf8'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  await inspect({ requireUnbound: true });
  assert.ok(existing === undefined, 'Second P9 scope file already exists');
  let scope;
  await withP6Provisioning(context, async pool => {
    await verifyP6ProvisioningGrants(context.primary);
    if (context.cedar) {
      const { rows: [state] } = await context.primary.query(`SELECT
        NOT EXISTS (SELECT FROM public."UserAccount") AND NOT EXISTS (SELECT FROM public."Idea")
        AND NOT EXISTS (SELECT FROM public."Conversation") AND NOT EXISTS (SELECT FROM public."GenerationAttempt")
        AND NOT EXISTS (SELECT FROM public."UsageLedger") AS empty`);
      assert.ok(state.empty, 'Cedar target is no longer fresh');
    }
    assert.ok(JSON.stringify(await history()) === historical,
      'Historical experiment changed before binding');
    await inspect({ requireUnbound: true });
    const account = await resolve(pool);
    const resolved = await inspect();
    assert.ok(resolved?.account === account && resolved.ideas === 0 && resolved.conversations === 0 &&
      previous.every(scope => account !== scope.FL_P9_SYNTHETIC_ACCOUNT), 'Unexpected synthetic account binding');
    await seedP9Conversation(context, account, title);
    scope = await inspect();
    assert.ok(scope?.conversation && scope.account === account, 'Second conversation ownership could not be verified');
    assert.ok(JSON.stringify(await history()) === historical,
      'Historical experiment changed during binding');
  });
  assert.ok(scope?.conversation, 'Second conversation unavailable');
  await writeFile(output, scopeText(scope), { flag: 'wx', mode: 0o600 });
}
