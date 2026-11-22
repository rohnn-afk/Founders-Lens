// Web authentication boundary tests. Start a built application without Clerk
// credentials to verify the fail-closed shell over HTTP and optionally Edge.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const require = createRequire(import.meta.url);

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
    const signal = AbortSignal.timeout(timeout);
    return new Promise(resolve => {
      socket.addEventListener('message', event => {
        const reply = JSON.parse(event.data);
        if (reply.id === id) resolve(reply.result?.result?.value);
      }, { signal });
      signal.addEventListener('abort', () => resolve(undefined), { once: true });
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
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

test('unconfigured sign-in and workspace fail closed without a Clerk session', { timeout: 30_000 }, async t => {
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
  skip: !process.argv.includes('--edge'), timeout: 60_000
}, async t => {
  const origin = await startWithoutClerk(t);
  await verifyInEdge(t, origin + '/sign-in',
    "document.body?.innerText.includes('Sign-in is unavailable until Clerk is configured.') === true");
});

for (const route of ['/sign-in', '/app']) {
  test(`configured Clerk reaches the sign-in form from ${route} on the IPv4 development server`, {
    skip: !process.argv.includes('--configured-edge'), timeout: 55_000
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

test('interactive Clerk session passes Express verification and loses access on sign-out', {
  skip: !process.argv.includes('--clerk-browser-live'), timeout: 2 * manualSignInTimeout + 190_000
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
