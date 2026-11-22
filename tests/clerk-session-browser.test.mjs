// Web authentication boundary tests. Start a built application without Clerk
// credentials to verify the fail-closed shell over HTTP and optionally Edge.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const browserLive = process.argv.includes('--clerk-browser-live');
const reverificationLive = process.argv.includes('--clerk-reverification-live');
const p6Bind = process.argv.includes('--p6-bind-account');
const p6Sign = process.argv.includes('--p6-sign-clearance');
const p7Sign = process.argv.includes('--p7-sign-create');
const p7Prepare = process.argv.includes('--p7-prepare-writer');
const workspaceCreateLive = process.argv.includes('--p7-create-browser-live');
const p8Prepare = process.argv.includes('--p8-prepare-role');
const p8Sign = process.argv.includes('--p8-sign-conversations');
const p8Live = process.argv.includes('--p8-conversations-browser-live');
const modes = [browserLive, reverificationLive, p6Bind, p6Sign, p7Sign, p7Prepare, workspaceCreateLive, p8Prepare, p8Sign, p8Live];
const interactiveMode = modes.some(Boolean);
if (modes.filter(Boolean).length > 1) throw new Error('Select exactly one Clerk test mode.');

test('P8 operator prepares restricted conversation role', { skip: !p8Prepare, timeout: 25_000 }, async t => {
  const { p6Operator, prepareP8Conversations } = await import('./fixtures/p6-local-operator.mjs');
  await prepareP8Conversations(await p6Operator(t), process.env.P6_OPERATOR_CONFIRM);
});

test('P8 operator signs conversation permissions', { skip: !p8Sign, timeout: 25_000 }, async t => {
  const { p6Operator, signP8Clearances } = await import('./fixtures/p6-local-operator.mjs');
  const values = await signP8Clearances(await p6Operator(t), process.env.P6_OPERATOR_PRIVATE_KEY_FILE,
    process.env.P6_OPERATOR_PUBLIC_KEY_FILE, process.env.P6_OPERATOR_CONFIRM);
  await writeFile('.env.p8.decisions.local', Object.entries(values).map(([key,value]) => `${key}='${value}'`).join('\n') + '\n',
    { flag: 'wx', mode: 0o600 });
});

/** Observe the owner's one conversation and message, then check persistence after a full refresh. */
test('P8 interactive Clerk saves a conversation message without generation', { skip: !p8Live, timeout: 420_000 }, async t => {
  const { p6Operator } = await import('./fixtures/p6-local-operator.mjs');
  const { clerkConfig } = await import('../apps/api/dist/security/config.js');
  const { createClerkBoundary } = await import('../apps/api/dist/security/clerk.js');
  const { ClerkIdentityProvider } = await import('../apps/api/dist/security/identity-provider.js');
  const env = process.env;
  const origin = 'http://127.0.0.1:3000';
  const config = clerkConfig({ ...env, CLERK_PUBLISHABLE_KEY: env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY });
  assert.ok(config.publishableKey.startsWith('pk_test_') && config.authorizedParties.includes(origin) &&
    /^user_[A-Za-z0-9_-]+$/.test(env.CLERK_TEST_USER_ID ?? ''), 'Approved development identity required');
  const boundary = createClerkBoundary({ ...config, authorizedParties: [origin] });
  const provider = new ClerkIdentityProvider(boundary.client);
  const context = await p6Operator(t);
  const counts = async () => (await context.primary.query(`SELECT
    (SELECT count(*)::int FROM "Conversation") AS conversations, (SELECT count(*)::int FROM "Message") AS messages,
    (SELECT count(*)::int FROM "GenerationAttempt") AS attempts, (SELECT count(*)::int FROM "UsageLedger") AS usage,
    (SELECT count(*)::int FROM "OutboxEvent") AS outbox`)).rows[0];
  const before = await counts();
  const evaluate = await openEdge(t, origin + '/app', true);
  const local = `location.origin === ${JSON.stringify(origin)}`;
  const ready = `${local} && window.Clerk?.session?.status === 'active'`;
  console.info('Sign in with the approved development account. Wait for the prompt before starting a conversation.');
  await waitForBrowser(async () => await evaluate(`${ready} && location.pathname === '/app' &&
    [...document.querySelectorAll('a')].some(a => a.textContent === 'Open conversations')`) === true, manualSignInTimeout);
  const bearer = async () => {
    const token = await evaluate(`(${ready}) ? window.Clerk.session.getToken({ skipCache: true }) : null`, 10_000);
    assert.ok(typeof token === 'string' && token.split('.').length === 3, 'Fresh Clerk session required');
    return 'Bearer ' + token;
  };
  const authorization = await bearer();
  const identity = await boundary.authenticate({ authorization }, ['Authorization', authorization]);
  assert.ok(identity.instanceId === config.instanceId && identity.subject === env.CLERK_TEST_USER_ID, 'Unexpected Clerk identity');
  await provider.assertLive(identity);
  console.info('Open the owned test idea, start one conversation, and save one clearly labeled test message.');
  const saved = await waitForBrowser(async () => {
    const path = await evaluate(`(${ready}) && /\\/conversations\\//.test(location.pathname) ? location.pathname : null`);
    const id = typeof path === 'string' && /^\/app\/ideas\/[0-9a-f-]+\/conversations\/([0-9a-f-]+)$/.exec(path)?.[1];
    if (!id) return null;
    const { rows } = await context.primary.query(`SELECT m.content->>'text' AS text FROM "Message" m JOIN "Idea" i ON i.id=m."ideaId"
      JOIN "UserAccount" a ON a.id=i."ownerId" WHERE m."conversationId"=$1 AND m.role='USER'
      AND a."clerkInstanceId"=$2 AND a."clerkSubject"=$3`, [id, identity.instanceId, identity.subject]);
    return rows.length === 1 && { id, path, text: rows[0].text };
  }, manualSignInTimeout);
  const displayed = `(${ready}) && location.pathname === ${JSON.stringify(saved.path)} &&
    [...document.querySelectorAll('[aria-label="Saved messages"] li p')].some(row => row.textContent === ${JSON.stringify(saved.text)})`;
  await waitForBrowser(async () => await evaluate(displayed) === true);
  const firstLoad = await evaluate('performance.timeOrigin');
  await evaluate(`if (${local}) location.reload()`);
  await waitForBrowser(async () => await evaluate(`(${displayed}) && performance.timeOrigin !== ${firstLoad}`) === true);
  assert.deepEqual(await counts(), { ...before, conversations: before.conversations + 1, messages: before.messages + 1 });
  const active = await bearer();
  await evaluate(`window.Clerk.signOut({ redirectUrl: '/sign-in' })`);
  await waitForBrowser(async () => await evaluate(`${local} && location.pathname.startsWith('/sign-in')`) === true);
  const denied = await fetch('http://127.0.0.1:3001/api/v1/conversations/' + saved.id + '/messages',
    { headers: { Authorization: active }, signal: AbortSignal.timeout(10_000) });
  assert.equal(denied.status, 401);
});

test('P7 operator prepares restricted idea writer', { skip: !p7Prepare, timeout: 25_000 }, async t => {
  const { p6Operator, prepareP7IdeaWriter } = await import('./fixtures/p6-local-operator.mjs');
  await prepareP7IdeaWriter(await p6Operator(t), process.env.P6_OPERATOR_CONFIRM);
});

/** Capture only the approved POST's idempotency key and body, never its bearer header. */
test('P7 interactive Clerk creates and replays one idea', { skip: !workspaceCreateLive, timeout: 420_000 }, async t => {
  const { p6Operator } = await import('./fixtures/p6-local-operator.mjs');
  const { clerkConfig } = await import('../apps/api/dist/security/config.js');
  const { createClerkBoundary } = await import('../apps/api/dist/security/clerk.js');
  const { ClerkIdentityProvider } = await import('../apps/api/dist/security/identity-provider.js');
  const context = await p6Operator(t);
  const origin = 'http://127.0.0.1:3000', endpoint = 'http://127.0.0.1:3001/api/v1/ideas';
  const env = process.env;
  const config = clerkConfig({ ...env, CLERK_PUBLISHABLE_KEY: env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY });
  assert.ok(config.publishableKey.startsWith('pk_test_') && config.authorizedParties.includes(origin) &&
    /^user_[A-Za-z0-9_-]+$/.test(env.CLERK_TEST_USER_ID ?? ''), 'Approved development identity required');
  const boundary = createClerkBoundary({ ...config, authorizedParties: [origin] });
  const provider = new ClerkIdentityProvider(boundary.client);
  const evaluate = await openEdge(t, origin + '/app', true);
  const shell = `location.origin === ${JSON.stringify(origin)} && location.pathname === '/app' &&
    window.Clerk?.session?.status === 'active' && !!document.querySelector('#idea-title')`;
  console.info('Sign in with the approved P7 development account. Wait for the prompt before saving.');
  await waitForBrowser(async () => await evaluate(shell) === true, manualSignInTimeout);
  const bearer = async () => {
    const token = await evaluate(`(${shell}) ? window.Clerk.session.getToken({ skipCache: true }) : null`, 10_000);
    assert.ok(typeof token === 'string' && token.split('.').length === 3, 'Fresh Clerk session required');
    return 'Bearer ' + token;
  };
  const authorization = await bearer();
  const identity = await boundary.authenticate({ authorization }, ['Authorization', authorization]);
  assert.ok(identity.instanceId === config.instanceId && identity.subject === env.CLERK_TEST_USER_ID, 'Unexpected Clerk identity');
  await provider.assertLive(identity);
  const matching = await context.primary.query(`SELECT id FROM "UserAccount"
    WHERE "clerkInstanceId"=$1 AND "clerkSubject"=$2 AND status='ACTIVE'`, [identity.instanceId, identity.subject]);
  assert.equal(matching.rowCount, 1);
  const count = async () => (await context.primary.query('SELECT count(*)::int AS total FROM "Idea" WHERE "ownerId"=$1',
    [matching.rows[0].id])).rows[0].total;
  const before = await count();
  await evaluate(`(() => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      if (String(input) === ${JSON.stringify(endpoint)} && init?.method === 'POST' && response.status === 201) {
        const idea = await response.clone().json();
        window.p7Accepted = { id: idea.id, key: new Headers(init.headers).get('Idempotency-Key'), body: init.body };
        window.fetch = original;
      }
      return response;
    };
  })()`);
  console.info('Save one approved development idea in Edge now. The harness will replay that exact request.');
  const accepted = await waitForBrowser(() => evaluate('window.p7Accepted ?? null'), manualSignInTimeout);
  assert.ok(typeof accepted.key === 'string' && typeof accepted.body === 'string' && typeof accepted.id === 'string');
  const title = JSON.parse(accepted.body).title;
  await waitForBrowser(async () => await evaluate(`(${shell}) && [...document.querySelectorAll('#owned-ideas ~ ul strong')]
    .some(item => item.textContent === ${JSON.stringify(title)})`) === true);
  const active = await bearer();
  const read = await fetch(endpoint, { headers: { Authorization: active }, signal: AbortSignal.timeout(10_000) });
  assert.equal(read.status, 200);
  assert.ok((await read.json()).items.some(idea => idea.id === accepted.id), 'Created idea missing from authorized list');
  const replay = await fetch(endpoint, { method: 'POST', headers: { Authorization: active,
    'Content-Type':'application/json', 'Idempotency-Key': accepted.key }, body: accepted.body, signal: AbortSignal.timeout(10_000) });
  assert.equal(replay.status, 201);
  assert.ok((await replay.json()).id === accepted.id, 'Replay did not return the original idea');
  assert.equal(await count(), before + 1);
  await evaluate(`window.Clerk.signOut({ redirectUrl: '/sign-in' })`);
  await waitForBrowser(async () => await evaluate(`location.origin === ${JSON.stringify(origin)} && location.pathname.startsWith('/sign-in')`) === true);
  assert.equal((await fetch(endpoint, { headers: { Authorization: active }, signal: AbortSignal.timeout(10_000) })).status, 401);
});

test(p7Sign ? 'P7 operator signs idea creation clearance' : 'P6 operator signs local recovery clearance',
  { skip: !p6Sign && !p7Sign, timeout: 25_000 }, async t => {
  const { p6Operator, signP6Clearance } = await import('./fixtures/p6-local-operator.mjs');
  const context = await p6Operator(t);
  const values = await signP6Clearance(context, process.env.P6_OPERATOR_PRIVATE_KEY_FILE,
    process.env.P6_OPERATOR_PUBLIC_KEY_FILE, process.env.P6_OPERATOR_CONFIRM, p7Sign);
  await writeFile(p7Sign ? '.env.p7.decision.local' : '.env.p6.decision.local', Object.entries(values)
    .map(([key, value]) => `${key}='${value}'`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
});

/** Keep Clerk credentials in the same process as verification and provisioning. */
test('P6 one-time Clerk binding', { skip: !p6Bind, timeout: 450_000 }, async t => {
  const { p6Operator, verifyP6ProvisioningGrants, withP6Provisioning } = await import('./fixtures/p6-local-operator.mjs');
  const { clerkConfig } = await import('../apps/api/dist/security/config.js');
  const { createClerkBoundary } = await import('../apps/api/dist/security/clerk.js');
  const { ClerkIdentityProvider } = await import('../apps/api/dist/security/identity-provider.js');
  const { IdentityService } = await import('../apps/api/dist/security/identity-service.js');
  const { PrismaIdentityRepository } = await import('../apps/api/dist/security/identity-repository.js');
  const { PrismaClient } = await import('../apps/api/dist/generated/prisma/client.js');
  const { PrismaPg } = createRequire(new URL('../apps/api/package.json', import.meta.url))('@prisma/adapter-pg');
  const env = process.env;
  const origin = 'http://127.0.0.1:3000';
  const config = clerkConfig({ ...env, CLERK_PUBLISHABLE_KEY: env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY });
  assert.ok(config.publishableKey.startsWith('pk_test_') && config.authorizedParties.includes(origin) &&
    /^user_[A-Za-z0-9_-]+$/.test(env.CLERK_TEST_USER_ID ?? '') &&
    (config.audience || env.CLERK_TEST_ALLOW_NO_AUDIENCE === '1'), 'Approved Clerk development identity required');
  const context = await p6Operator(t);
  await verifyP6ProvisioningGrants(context.primary);
  const boundary = createClerkBoundary({ ...config, authorizedParties: [origin] });
  const provider = new ClerkIdentityProvider(boundary.client);
  const evaluate = await openEdge(t, origin + '/app', true);
  const shell = `location.origin === ${JSON.stringify(origin)} && location.pathname === '/app' &&
    document.body?.innerText.includes('You are signed in.') && window.Clerk?.session?.status === 'active'`;
  console.info('Edge is ready for the approved P6 development account. Sign in within three minutes.');
  await waitForBrowser(async () => await evaluate(shell) === true, manualSignInTimeout);
  const token = await evaluate(`(${shell}) ? window.Clerk.session.getToken({ skipCache: true }) : null`, 10_000);
  assert.ok(typeof token === 'string' && token.split('.').length === 3, 'Fresh Clerk session required');
  const header = 'Bearer ' + token;
  const identity = await boundary.authenticate({ authorization: header }, ['Authorization', header]);
  assert.ok(identity.instanceId === config.instanceId && identity.subject === env.CLERK_TEST_USER_ID &&
    (config.audience || !Object.hasOwn(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()), 'aud')),
  'Clerk identity or audience does not match the approved policy');
  await provider.assertLive(identity);
  const readCounts = async () => (await context.primary.query(`SELECT
    (SELECT count(*)::int FROM "UserAccount") AS accounts,
    (SELECT count(*)::int FROM "UserAccount" WHERE "clerkInstanceId"=$1 AND "clerkSubject"=$2
      AND status='ACTIVE' AND "subjectKeyVersion"=$3 AND "subjectKey"=$4) AS matching,
    (SELECT count(*)::int FROM "Idea") AS ideas, (SELECT count(*)::int FROM "Conversation") AS conversations,
    (SELECT count(*)::int FROM "Message") AS messages, (SELECT count(*)::int FROM "DataOperation") AS operations,
    (SELECT count(*)::int FROM "IdentityTombstone") AS tombstones`, [identity.instanceId, identity.subject, 1,
    context.subjectKeys.derive(identity.instanceId, identity.subject)[0].digest])).rows[0];
  const expected = { accounts: 1, matching: 1, ideas: 0, conversations: 0, messages: 0, operations: 0, tombstones: 0 };
  const before = await readCounts();
  if (before.accounts === 0) {
    assert.deepEqual(before, { ...expected, accounts: 0, matching: 0 });
    await withP6Provisioning(context, async pool => {
      await verifyP6ProvisioningGrants(context.primary);
      assert.deepEqual(await readCounts(), before);
      const prisma = new PrismaClient({ adapter: new PrismaPg(pool), log: [], errorFormat: 'minimal' });
      try {
        const service = new IdentityService(config.instanceId, context.subjectKeys, provider,
          new PrismaIdentityRepository(prisma), context.ledger.authority);
        await service.resolve(identity, 'p6-one-time-binding');
        assert.deepEqual(await readCounts(), expected);
      } finally { await prisma.$disconnect(); }
    });
  } else {
    // A prior committed binding is verified by read-back without re-opening the writer.
    assert.deepEqual(before, expected);
  }
  await context.verify();
  console.info('P6 binding verified. Accounts 1, ideas 0, conversations 0, messages 0.');
  console.info('Start the P6 API with the separately signed decision, then use Retry in Edge.');
  await waitForBrowser(async () => await evaluate(`(${shell}) && document.body.innerText.includes('You don’t have any ideas yet.')`) === true,
    manualSignInTimeout, () => 'Authorized empty workspace was not observed.');
  const activeToken = await evaluate(`(${shell}) ? window.Clerk.session.getToken({ skipCache: true }) : null`, 10_000);
  assert.ok(typeof activeToken === 'string' && activeToken.split('.').length === 3, 'Fresh Clerk session required');
  const headers = { Authorization: 'Bearer ' + activeToken };
  const response = await fetch('http://127.0.0.1:3001/api/v1/ideas', { headers, signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(Array.isArray(result.items) && result.items.length === 0 &&
    result.page?.nextCursor === null && result.page?.hasMore === false, 'Expected the authorized empty idea list');
  await evaluate(`if (${shell}) window.Clerk.signOut({ redirectUrl: '/sign-in' })`);
  await waitForBrowser(async () => await evaluate(`location.origin === ${JSON.stringify(origin)} && location.pathname.startsWith('/sign-in')`) === true);
  const denied = await fetch('http://127.0.0.1:3001/api/v1/ideas', { headers, signal: AbortSignal.timeout(10_000) });
  assert.equal(denied.status, 401);
});


async function waitForBrowser(check, timeout = 20_000, failure = () => 'Edge did not reach the expected sign-in state.') {
  const deadline = Date.now() + timeout;
  do {
    const result = await check();
    if (result) return result;
    await sleep(150);
  } while (Date.now() < deadline);
  throw new Error(failure());
}

async function openEdge(t, url, interactive = false) {
  const profile = await mkdtemp(join(tmpdir(), 'fl-clerk-edge-'));
  const edge = process.env.WORKSPACE_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const browser = spawn(edge, [
    ...(interactive ? ['--inprivate'] : ['--headless']), '--disable-gpu', '--no-first-run', '--disable-background-networking',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + profile, url
  ], { windowsHide: !interactive, stdio: 'ignore' });
  const exited = once(browser, 'close');
  let socket;
  t.after(async () => {
    socket?.close();
    browser.kill();
    await exited;
    await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  });
  const endpoint = await waitForBrowser(async () => {
    try {
      const port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]);
      const tabs = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) }).then(r => r.json());
      const tab = tabs.find(entry => entry.type === 'page');
      const target = new URL(tab.webSocketDebuggerUrl);
      if (target.hostname === '127.0.0.1' && target.port === String(port)) return target;
    } catch { /* Edge is still starting. */ }
  });
  socket = new WebSocket(endpoint);
  await once(socket, 'open');
  let closeCode;
  socket.addEventListener('close', event => { closeCode = event.code; }, { once: true });
  let sequence = 0;
  return (expression, timeout = 1200) => {
    if (socket.readyState !== WebSocket.OPEN) {
      const processState = browser.exitCode !== null ? `exited with code ${browser.exitCode}` :
        browser.signalCode ? 'terminated by signal' : 'still running according to the child process handle';
      throw new Error(`Disposable Edge automation connection closed (WebSocket code ${closeCode ?? 'unavailable'}; Edge process ${processState}).`);
    }
    const id = ++sequence;
    const listeners = new AbortController();
    let timer;
    const result = new Promise(resolve => {
      socket.addEventListener('message', event => {
        const reply = JSON.parse(event.data);
        if (reply.id === id) resolve(reply.result?.result?.value);
      }, { signal: listeners.signal });
      socket.addEventListener('close', () => resolve(undefined), { signal: listeners.signal });
      timer = setTimeout(() => resolve(undefined), timeout);
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    });
    // Successful evaluations must release their listeners before the next poll.
    return result.finally(() => {
      clearTimeout(timer);
      listeners.abort();
    });
  };
}

async function verifyInEdge(t, url, expression) {
  const evaluate = await openEdge(t, url);
  await waitForBrowser(async () => await evaluate(expression) === true);
}

async function startWithoutClerk(t) {
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', 'apps/web',
    '--hostname', '127.0.0.1', '--port', String(port)], {
    env: { ...process.env, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: '', CLERK_SECRET_KEY: '', NEXT_TELEMETRY_DISABLED: '1' },
    stdio: 'ignore', windowsHide: true
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    child.kill('SIGTERM');
    await exited;
  });
  const origin = 'http://127.0.0.1:' + port;
  for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) {
    if (await fetch(origin, { signal: AbortSignal.timeout(500) }).then(response => response.ok, () => false)) return origin;
    await sleep(100);
  }
  throw new Error('Unable to start the unconfigured web application.');
}

// Interactive runs use the configured development server and do not require a
// separately built application for the unconfigured startup checks.
test('unconfigured sign-in and workspace fail closed without a Clerk session', {
  skip: interactiveMode, timeout: 30_000
}, async t => {
  const origin = await startWithoutClerk(t);
  const signIn = await fetch(origin + '/sign-in');
  assert.equal(signIn.status, 200);
  assert.match(await signIn.text(), /Sign-in is unavailable until Clerk is configured/);
  for (const path of ['/app', '/app/ideas/00000000-0000-4000-8000-000000000001/think']) {
    const response = await fetch(origin + path, { headers: { Cookie: '__session=untrusted-test-cookie' } });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Workspace unavailable/);
    assert.doesNotMatch(html, /You are signed in/);
  }
});

test('Edge renders the unconfigured sign-in notice in a fresh browser profile', {
  skip: interactiveMode || !process.argv.includes('--edge'), timeout: 60_000
}, async t => {
  const origin = await startWithoutClerk(t);
  await verifyInEdge(t, origin + '/sign-in',
    "document.body?.innerText.includes('Sign-in is unavailable until Clerk is configured.') === true");
});

for (const route of ['/sign-in', '/app']) {
  test(`configured Clerk reaches the sign-in form from ${route} on the IPv4 development server`, {
    skip: interactiveMode || !process.argv.includes('--configured-edge'), timeout: 55_000
  }, async t => {
    // Use a fresh profile so the real Clerk development handshake must run.
    // Only assert booleans so browser DOM and protocol data cannot enter logs.
    await verifyInEdge(t, 'http://127.0.0.1:3000' + route, `
      location.origin === 'http://127.0.0.1:3000' && location.pathname.startsWith('/sign-in') &&
      document.body?.innerText.includes('Sign in to Founder') === true &&
      !!document.querySelector('input[name=identifier], input[type=email], input[type=password]') &&
      !document.body.innerText.includes('You are signed in.')`);
  });
}

const manualSignInTimeout = 180_000;

// IMP7C-M02-T02, partial evidence. The owner reported this live test passed
// (1 passed, 0 failed) after 63e867b. It exercises the verifier and provider
// adapter directly. Private routes, ownership, and durable suppression are separate gates.
test('interactive Clerk session passes Express verification and loses access on sign-out', {
  skip: !browserLive, timeout: 2 * manualSignInTimeout + 190_000
}, async t => {
  const { clerkConfig } = await import('../apps/api/dist/security/config.js');
  const { createClerkBoundary } = await import('../apps/api/dist/security/clerk.js');
  const { ClerkIdentityProvider } = await import('../apps/api/dist/security/identity-provider.js');
  const env = process.env;
  const origin = 'http://127.0.0.1:3000';
  const missing = ['CLERK_INSTANCE_ID', 'CLERK_ISSUER', 'CLERK_TEST_USER_ID'].filter(name => !env[name]);
  if (!env.CLERK_AUDIENCE && env.CLERK_TEST_ALLOW_NO_AUDIENCE !== '1') {
    missing.push('CLERK_AUDIENCE or CLERK_TEST_ALLOW_NO_AUDIENCE=1');
  }
  assert.ok(missing.length === 0, 'Missing approved configuration: ' + missing.join(', '));
  const config = clerkConfig({ ...env, CLERK_PUBLISHABLE_KEY: env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY });
  assert.ok(config.publishableKey.startsWith('pk_test_') && config.authorizedParties.includes(origin) &&
    /^user_[A-Za-z0-9_-]+$/.test(env.CLERK_TEST_USER_ID ?? '') &&
    (config.audience || env.CLERK_TEST_ALLOW_NO_AUDIENCE === '1'), 'Approved development session configuration required.');
  const boundary = createClerkBoundary(config);
  const provider = new ClerkIdentityProvider(boundary.client);
  const verify = (token, verifier = boundary) => {
    const authorization = 'Bearer ' + token;
    return verifier.authenticate({ authorization }, ['Authorization', authorization]);
  };
  const rejected = error => error?.code === 'UNAUTHENTICATED';
  const evaluate = await openEdge(t, origin + '/app', true);
  const local = `location.origin === ${JSON.stringify(origin)}`;
  const shell = `${local} && location.pathname === '/app' &&
    document.body?.innerText.includes('You are signed in.') && window.Clerk?.session?.status === 'active'`;
  const signIn = `${local} && location.pathname === '/sign-in' && !!document.querySelector('input')`;
  const wait = (expression, timeout) => waitForBrowser(async () => await evaluate(expression) === true, timeout);
  const waitForManualSignIn = async (attempt) => {
    let state = 'waiting for browser diagnostics';
    let nextUpdate = 0;
    console.info(`Edge is ready for manual sign-in (${attempt}/2). Use the approved Clerk test account. You have three minutes.`);
    await waitForBrowser(async () => {
      const observed = await evaluate(`(${shell}) ? 'authenticated shell' :
        !(${local}) ? 'outside expected origin' :
        location.pathname === '/app' ?
          (document.body?.innerText.includes('You are signed in.') ? 'shell waiting for active Clerk session' : 'workspace awaiting server verification') :
        location.pathname === '/sign-in' ? 'sign-in page' :
        location.pathname.startsWith('/sign-in/') ? 'Clerk sign-in subroute' : 'other local route'`);
      // Report only fixed categories. Callback URLs can carry credentials.
      if (observed && (observed !== state || Date.now() >= nextUpdate)) {
        state = observed;
        nextUpdate = Date.now() + 30_000;
        console.info(`Edge sign-in ${attempt}/2 — ${state}.`);
      }
      return observed === 'authenticated shell';
    }, manualSignInTimeout, () => `Manual sign-in ${attempt}/2 timed out. Last observed state: ${state}.`);
  };
  const navigate = async (action, destination) => {
    const before = await evaluate(`${local} && performance.timeOrigin`);
    assert.ok(typeof before === 'number', 'Expected the local application before navigation.');
    await evaluate(`if (${local}) ${action}`);
    await wait(`(${destination}) && performance.timeOrigin !== ${before}`);
  };
  const refresh = () => navigate('location.reload()', shell);
  const readSession = async () => {
    // CDP returns the SDK result directly to this process. No cookies or application endpoint are involved.
    const token = await evaluate(`(${shell}) ? window.Clerk.session.getToken({ skipCache: true }) : null`, 10_000);
    assert.ok(typeof token === 'string' && token.split('.').length === 3, 'Fresh session token unavailable.');
    const identity = await verify(token);
    assert.ok(identity.subject === env.CLERK_TEST_USER_ID, 'Unexpected Clerk test account.');
    await provider.assertLive(identity);
    if (!config.audience) {
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
      assert.ok(!Object.hasOwn(claims, 'aud'), 'Session disagrees with the approved audience policy.');
    }
    return { token, identity };
  };

  await wait(signIn);
  await waitForManualSignIn(1);
  await refresh();
  const first = await readSession();
  const [header, payload, signature] = first.token.split('.');
  const tampered = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
  await assert.rejects(verify([header, payload, tampered].join('.')), rejected);
  await assert.rejects(verify('malformed'), rejected);
  for (const policy of [
    { issuer: 'https://unexpected-issuer.invalid' },
    { authorizedParties: ['https://unexpected-party.invalid'] },
    { audience: ['urn:founders-lens:unexpected-audience'] }
  ]) {
    await assert.rejects(verify(first.token, createClerkBoundary({ ...config, ...policy })), rejected);
  }
  const active = await readSession();
  await evaluate(`if (${shell}) [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Sign out')?.click()`);
  await wait(signIn);
  await navigate("location.assign('/app')", signIn);
  await assert.rejects(provider.assertLive(active.identity), rejected);
  await waitForManualSignIn(2);
  await refresh();
  await readSession();
  const expiryDelay = Math.max(0, first.identity.expiresAt - Date.now() + 100);
  assert.ok(expiryDelay <= 90_000, 'Unexpected lifetime for the approved development token.');
  await sleep(expiryDelay);
  await assert.rejects(verify(first.token), rejected);
});

const reverificationWindowMs = 5 * 60_000;

/** Match a provider completion to the signed session and enforce factor freshness. */
function deletionEvidenceIsFresh(record, evidence, requireMfa, now = Date.now()) {
  if (!record || record.status !== 'complete' || record.id !== evidence.challengeId ||
      record.session_id !== evidence.sessionId || record.user_id !== evidence.subject ||
      record.level !== (requireMfa ? 'multi_factor' : 'first_factor') ||
      !Number.isSafeInteger(record.created_at)) return false;
  const fresh = timestamp => Number.isSafeInteger(timestamp) && timestamp >= record.created_at &&
    timestamp <= now && now - timestamp <= reverificationWindowMs;
  return fresh(record.first_factor_verified_at) && (!requireMfa || fresh(record.second_factor_verified_at));
}

test('reverification proof rejects incomplete, mismatched, stale and downgraded evidence', { skip: browserLive }, () => {
  const evidence = { challengeId: 'challenge', sessionId: 'session', subject: 'subject' };
  const now = 1_000_000;
  const timestamp = now - reverificationWindowMs;
  const record = { id: evidence.challengeId, session_id: evidence.sessionId, user_id: evidence.subject,
    status: 'complete', level: 'first_factor', created_at: timestamp - 1, first_factor_verified_at: timestamp };
  assert.equal(deletionEvidenceIsFresh(record, evidence, false, now), true);
  assert.equal(deletionEvidenceIsFresh(record, evidence, false, now + 1), false);
  assert.equal(deletionEvidenceIsFresh(record, evidence, true, now), false);
  for (const change of [{ status: 'needs_first_factor' }, { session_id: 'foreign' },
    { user_id: 'foreign' }, { id: 'foreign' }, { first_factor_verified_at: timestamp - 2 }]) {
    assert.equal(deletionEvidenceIsFresh({ ...record, ...change }, evidence, false, now), false);
  }
  const mfa = { ...record, level: 'multi_factor' };
  assert.equal(deletionEvidenceIsFresh(mfa, evidence, true, now), false);
  assert.equal(deletionEvidenceIsFresh({ ...mfa, second_factor_verified_at: timestamp }, evidence, true, now), true);
});

/** Read the exact session-scoped Clerk record with the pinned Backend API version. */
async function readClerkReverification(secretKey, evidence) {
  const { sessionId, challengeId } = evidence;
  assert.ok(/^[A-Za-z0-9_-]{1,250}$/.test(challengeId), 'Signed challenge identifier unavailable.');
  const response = await fetch(
    'https://api.clerk.com/v1/sessions/' + encodeURIComponent(sessionId) +
    '/reverifications/' + encodeURIComponent(challengeId), {
      headers: { Authorization: 'Bearer ' + secretKey, 'Clerk-API-Version': '2026-05-12' },
      redirect: 'error', signal: AbortSignal.timeout(8000)
    });
  assert.ok(response.ok, 'Provider challenge lookup failed with HTTP ' + response.status + '.');
  return response.json();
}

/**
 * Render a temporary factor form in the disposable tab. Codes travel directly
 * from that form to Clerk's client SDK. CDP receives only fixed status labels.
 * This fixture supports email code and, when required, enrolled TOTP.
 */
async function completeBrowserChallenge(evaluate, local, requireMfa) {
  const installed = await evaluate(`(async () => {
    if (!(${local}) || location.pathname !== '/app') return false;
    const session = window.Clerk.session;
    const form = document.createElement('form');
    const label = document.createElement('label');
    const input = document.createElement('input');
    const button = document.createElement('button');
    const hint = document.createElement('p');
    form.id = 'clerk-reverification-proof';
    form.dataset.state = 'preparing';
    input.type = 'password';
    input.autocomplete = 'off';
    button.textContent = 'Verify';
    button.disabled = true;
    label.append('Clerk verification code ', input);
    form.append(label, button, hint);
    document.body.prepend(form);
    try {
      const email = window.Clerk.user.primaryEmailAddressId;
      if (!email) throw new Error();
      const prepared = await session.prepareFirstFactorVerification({ strategy: 'email_code', emailAddressId: email });
      if (prepared.status !== 'needs_first_factor') throw new Error();
      hint.textContent = 'Enter the email code from Clerk in this browser.';
      form.dataset.state = 'awaiting first factor';
      button.disabled = false;
      form.addEventListener('submit', async event => {
        event.preventDefault();
        const second = form.dataset.state === 'awaiting TOTP';
        const code = input.value;
        input.value = '';
        button.disabled = true;
        try {
          const verification = second ?
            await session.attemptSecondFactorVerification({ strategy: 'totp', code }) :
            await session.attemptFirstFactorVerification({ strategy: 'email_code', code });
          if (verification.status === 'needs_second_factor' && ${requireMfa} && !second &&
              verification.supportedSecondFactors?.some(factor => factor.strategy === 'totp')) {
            form.dataset.state = 'awaiting TOTP';
            hint.textContent = 'Enter the authenticator code in this browser.';
            button.disabled = false;
          } else {
            form.dataset.state = verification.status === 'complete' && (!${requireMfa} || second) ? 'complete' : 'unexpected factor state';
          }
        } catch {
          form.dataset.state = 'factor attempt failed';
        }
      });
      return true;
    } catch {
      form.dataset.state = 'factor preparation failed';
      return false;
    }
  })()`, 15_000);
  assert.ok(installed === true, 'Clerk email factor preparation did not succeed.');
  await waitForBrowser(async () => {
    const state = await evaluate(`(${local}) && document.getElementById('clerk-reverification-proof')?.dataset.state`);
    assert.ok(!['unexpected factor state', 'factor attempt failed'].includes(state),
      'Clerk did not complete the required factors.');
    return state === 'complete';
  }, manualSignInTimeout, () => 'Manual Clerk factor completion timed out.');
}

// Owner-run proof after 8513c36 passed with a single factor. MFA acceptance
// still requires separate live evidence from an approved MFA-enabled account.
test('interactive Clerk reverification distinguishes abandoned and completed challenges', {
  skip: !reverificationLive, timeout: 450_000
}, async t => {
  const { clerkConfig } = await import('../apps/api/dist/security/config.js');
  const { createClerkBoundary } = await import('../apps/api/dist/security/clerk.js');
  const { ClerkIdentityProvider } = await import('../apps/api/dist/security/identity-provider.js');
  const env = process.env;
  const origin = 'http://127.0.0.1:3000';
  const config = clerkConfig({ ...env, CLERK_PUBLISHABLE_KEY: env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY });
  assert.ok(config.publishableKey.startsWith('pk_test_') && config.authorizedParties.includes(origin) &&
    /^user_[A-Za-z0-9_-]+$/.test(env.CLERK_TEST_USER_ID ?? '') &&
    (config.audience || env.CLERK_TEST_ALLOW_NO_AUDIENCE === '1'), 'Approved development session configuration required.');
  const boundary = createClerkBoundary(config);
  const provider = new ClerkIdentityProvider(boundary.client);
  const local = `location.origin === ${JSON.stringify(origin)}`;
  const shell = `${local} && location.pathname === '/app' &&
    document.body?.innerText.includes('You are signed in.') && window.Clerk?.session?.status === 'active'`;
  const evaluate = await openEdge(t, origin + '/app', true);
  console.info('Sign in to the disposable Edge window with the approved Clerk test account.');
  await waitForBrowser(async () => await evaluate(shell) === true, manualSignInTimeout);
  let expectedIdentity;

  /** Verify each refreshed bearer before using its signed challenge and factor claims. */
  async function readEvidence() {
    const token = await evaluate(`(${shell}) ? window.Clerk.session.getToken({ skipCache: true }) : null`, 10_000);
    assert.ok(typeof token === 'string' && token.split('.').length === 3, 'Fresh session token unavailable.');
    const authorization = 'Bearer ' + token;
    const identity = await boundary.authenticate({ authorization }, ['Authorization', authorization]);
    assert.ok(identity.subject === env.CLERK_TEST_USER_ID &&
      (!expectedIdentity || identity.sessionId === expectedIdentity.sessionId), 'Clerk test identity or session changed.');
    await provider.assertLive(identity);
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    assert.ok(config.audience || !Object.hasOwn(claims, 'aud'), 'Session disagrees with the approved audience policy.');
    assert.ok(Array.isArray(claims.fva) && claims.fva.length === 2 && claims.fva.every(Number.isInteger),
      'Signed factor ages unavailable.');
    return { ...identity, challengeId: claims.reverification_id, factorAges: claims.fva };
  }

  expectedIdentity = await readEvidence();
  const user = await boundary.client.users.getUser(expectedIdentity.subject);
  assert.ok(typeof user.twoFactorEnabled === 'boolean', 'Provider did not establish the account factor policy.');
  const requireMfa = user.twoFactorEnabled || env.CLERK_TEST_REQUIRE_MFA === '1';
  const level = requireMfa ? 'multi_factor' : 'first_factor';
  const start = () => evaluate(`(async () => {
    if (!(${shell})) return false;
    const result = await window.Clerk.session.startVerification({ level: ${JSON.stringify(level)} });
    return result.status === 'needs_first_factor';
  })()`, 10_000);

  // Starting a challenge must not turn a recent factor from ordinary sign-in into completion evidence.
  assert.ok(await start() === true, 'Clerk did not start a first-factor challenge.');
  const abandoned = await readEvidence();
  assert.ok(abandoned.challengeId !== expectedIdentity.challengeId, 'New signed challenge identifier unavailable.');
  assert.ok(abandoned.factorAges[0] >= 0 && abandoned.factorAges[0] < 5, 'Prior first-factor evidence must still be fresh.');
  const pending = await readClerkReverification(config.secretKey, abandoned);
  assert.ok(pending.id === abandoned.challengeId && pending.session_id === abandoned.sessionId &&
    pending.user_id === abandoned.subject && pending.status === 'needs_first_factor',
  'Provider did not bind the incomplete challenge to this identity.');
  assert.ok(!deletionEvidenceIsFresh(pending, abandoned, requireMfa), 'Incomplete challenge qualified for deletion.');

  assert.ok(await start() === true, 'Clerk did not start a separate challenge.');
  const second = await readEvidence();
  assert.ok(second.challengeId !== abandoned.challengeId, 'Second challenge reused the abandoned identifier.');
  const old = await readClerkReverification(config.secretKey, abandoned);
  assert.ok(!deletionEvidenceIsFresh(old, abandoned, requireMfa), 'Abandoned challenge qualified for deletion.');
  console.info('Complete the Clerk factor prompt in Edge. Enter codes only in the disposable browser.');
  await completeBrowserChallenge(evaluate, local, requireMfa);
  const completed = await readEvidence();
  assert.ok(completed.challengeId === second.challengeId, 'Completed claim does not match the started challenge.');
  assert.ok(completed.factorAges[0] >= 0 && completed.factorAges[0] <= 5 &&
    (!requireMfa || (completed.factorAges[1] >= 0 && completed.factorAges[1] <= 5)),
  'Signed factor ages do not meet the proof policy.');
  const record = await readClerkReverification(config.secretKey, completed);
  assert.ok(deletionEvidenceIsFresh(record, completed, requireMfa), 'Provider completion did not satisfy the proof policy.');
  // Advance only the proof evaluator clock. JWT verification and Clerk clocks remain real.
  assert.ok(!deletionEvidenceIsFresh(record, completed, requireMfa,
    record.first_factor_verified_at + reverificationWindowMs + 1), 'Stale completion qualified for deletion.');
  console.info(requireMfa ? 'Provider completion verified with two factors.' : 'Provider completion verified with one factor.');
});
