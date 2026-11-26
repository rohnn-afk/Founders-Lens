// Operator entry point for the approved disposable Clerk/offline journey.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { parseEnv } from 'node:util';
import { setTimeout as wait } from 'node:timers/promises';
import { p6Operator, signIdeaEditClearance, signP6Clearance, signP8Clearances, signP9Clearances } from '../tests/fixtures/p6-local-operator.mjs';

const fixturePrompt = 'Fictional startup Lantern Locker rents reusable picnic kits. What should we test first?';
const manifest = async path => parseEnv(await readFile(path, 'utf8'));
const cleanup = [];
const children = [];
try {
  const [phase, conversation, ...extra] = process.argv.slice(2);
  assert.ok(extra.length === 0 && (phase === 'workspace' && conversation === undefined ||
    phase === 'generation' && (conversation === undefined ||
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(conversation.trim()))), 'Invalid acceptance phase');
  assert.ok(process.env.FL_DEPLOYMENT === undefined && process.env.NODE_ENV !== 'production', 'Local operator process required');
  const secretInput = await manifest('.env.clerk-staging.local');
  const local = await manifest('.env.p9-offline-api.local');
  const worker = await manifest('.env.p9-offline-worker.local');
  const context = await p6Operator({ after: fn => cleanup.push(fn) }, { isolated: true, offline: true });
  const { rows: accounts } = await context.primary.query(`SELECT id FROM public."UserAccount"
    WHERE "clerkInstanceId"=$1 AND "clerkSubject"=$2 AND status='ACTIVE'`,
  [secretInput.CLERK_INSTANCE_ID, secretInput.CLERK_TEST_USER_ID]);
  assert.equal(accounts.length, 1, 'Verify the designated Clerk binding before launch');
  const keys = [process.env.P6_OPERATOR_PRIVATE_KEY_FILE, process.env.P6_OPERATOR_PUBLIC_KEY_FILE];
  assert.ok(keys.every(Boolean), 'Protected operator key paths required');
  const settings = {
    NODE_ENV: 'development', FL_P9_OFFLINE_ACCEPTANCE: '1', FL_P9_LOCAL_RUNTIME: 'deterministic',
    FL_P9_ISOLATED: '1', P9_GEMINI_MODEL: 'gemini-3.1-flash-lite', FL_P9_PRICE_VERSION: 'v1:offline-fixture',
    FL_P9_MAX_MICROS_PER_MILLION_TOKENS: '1500000', FL_P9_BUDGET_MICROS: '6912', FL_P9_ACCOUNT_TOKEN_BUDGET: '4608',
    FL_P9_MAX_ADMISSIONS: '1', FL_P9_REQUESTS_PER_MINUTE: '1'
  };
  const os = Object.fromEntries(['PATH', 'SystemRoot', 'TEMP', 'TMP'].filter(name => process.env[name])
    .map(name => [name, process.env[name]]));
  const api = { ...os, ...local, ...settings, CLERK_AUTHORIZED_PARTIES: '["http://127.0.0.1:3000"]',
    API_PORT: '3001', FL_P6_READ_ONLY: '1', FL_P7_CREATE_IDEA: '1', FL_IDEA_EDIT: '1', FL_P8_CONVERSATIONS: '1',
    ...await signP6Clearance(context, ...keys, 'approve-p6-genesis-read-only'),
    ...await signP6Clearance(context, ...keys, 'approve-p7-create-idea', true),
    ...await signIdeaEditClearance(context, ...keys, 'approve-local-idea-edit'),
    ...await signP8Clearances(context, ...keys, 'approve-p8-conversations') };
  for (const name of ['CLERK_INSTANCE_ID', 'CLERK_ISSUER', 'CLERK_SECRET_KEY', 'CLERK_PUBLISHABLE_KEY', 'CLERK_AUDIENCE']) {
    assert.ok(secretInput[name], 'Clerk configuration incomplete');
    api[name] = secretInput[name];
  }
  let processor;
  if (phase === 'generation') {
    const account = accounts[0].id;
    const { rows } = await context.primary.query(`SELECT c.id FROM public."Conversation" c
      JOIN public."Idea" i ON i.id=c."ideaId" WHERE ($1::uuid IS NULL OR c.id=$1) AND i."ownerId"=$2
      AND c.status='ACTIVE' AND i.status='ACTIVE' AND c."nextSequence"=1
      AND NOT EXISTS (SELECT FROM public."Message" WHERE "conversationId"=c.id)
      AND NOT EXISTS (SELECT FROM public."GenerationAttempt" g JOIN public."Conversation" existing
        ON existing.id=g."conversationId" JOIN public."Idea" owned ON owned.id=existing."ideaId"
        WHERE owned."ownerId"=$2) LIMIT 2`, [conversation?.trim() ?? null, account]);
    assert.equal(rows.length, 1, 'Select one owned, empty conversation on an unused offline account');
    const scope = { FL_P9_SYNTHETIC_ACCOUNT: account, FL_P9_SYNTHETIC_CONVERSATION: rows[0].id,
      FL_P9_SYNTHETIC_TEXT_SHA256: createHash('sha256').update(fixturePrompt).digest('hex') };
    const decisions = await signP9Clearances(context, ...keys, 'approve-p9-isolated-runtime');
    const { FL_P9_DISPATCH_DECISION, FL_P9_EXECUTE_DECISION, ...apiDecisions } = decisions;
    Object.assign(api, scope, apiDecisions, { FL_P9_SUBMIT: '1' });
    processor = { ...os, ...worker, ...settings, ...scope, FL_P6_OPERATOR_PUBLIC_KEY: decisions.FL_P6_OPERATOR_PUBLIC_KEY,
      FL_P9_DISPATCH_DECISION, FL_P9_EXECUTE_DECISION, FL_P9_REDIS_RUN: randomUUID() };
  }
  function launch(path, env) {
    const child = spawn(process.execPath, [path], { env, stdio: 'inherit', windowsHide: true });
    children.push(child);
    return new Promise(resolve => {
      child.once('error', () => resolve(1));
      child.once('exit', code => resolve(code ?? 1));
    });
  }
  const reservation = createServer();
  await new Promise((resolve, reject) => reservation.once('error', reject)
    .listen({ host: '127.0.0.1', port: 3001, exclusive: true }, resolve));
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  await Promise.all(cleanup.splice(0).map(fn => fn()));
  const runs = [launch('apps/api/dist/main.js', api)];
  const checkMount = async () => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const response = await fetch('http://127.0.0.1:3001/openapi.json',
        { signal: AbortSignal.timeout(500), redirect: 'error' }).catch(() => undefined);
      if (response?.ok) {
        const { paths } = await response.json();
        const has = (method, match) => Object.entries(paths ?? {}).some(([path, value]) => match.test(path) && value[method]);
        assert.ok(has('get', /\/ideas$/) && has('post', /\/ideas$/) && has('patch', /\/ideas\/\{[^}]+\}$/) &&
          has('post', /\/ideas\/\{[^}]+\}\/conversations$/) &&
          (!processor || has('post', /\/conversations\/\{[^}]+\}\/messages$/) && has('get', /\/generations\/\{[^}]+\}\/events$/)),
        'Local API did not mount the required acceptance operations');
        return;
      }
      await wait(100);
    }
    throw new Error('Local API did not become available');
  };
  const mounted = await Promise.race([checkMount().then(() => true), runs[0].then(() => false)]);
  assert.ok(mounted, 'Local API stopped before acceptance routes were verified');
  if (processor) {
    runs.push(launch('scripts/p9-local-runtime.mjs', processor));
    console.info('Offline fixture prompt:', fixturePrompt);
  }
  const stop = () => children.forEach(child => child.kill());
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.exitCode = await Promise.race(runs);
} catch (error) {
  console.error(error instanceof assert.AssertionError ? error.message : 'Offline acceptance stopped during local verification.');
  process.exitCode = 1;
} finally {
  children.forEach(child => child.kill());
  await Promise.allSettled(cleanup.map(fn => fn()));
}
