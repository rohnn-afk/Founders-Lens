// Process smoke tests. Node launches the compiled API, worker, dispatcher,
// and Next.js to verify public behavior and startup and shutdown boundaries.

import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { constants } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
// Windows kill() terminates a process rather than delivering a catchable POSIX
// signal. This test-only preload observes delivery in the actual child process;
// Windows invokes its real handlers via IPC, while POSIX delivers an OS signal.
// Application start scripts never load this bridge.
// IPC means inter-process communication. The test uses it to ask the child
// to exercise its own shutdown handler and send back an observation.
function shutdownBridge() {
  process.once('message', (message) => {
    const { type, pid, signal, nonce } = message;
    if (type !== 'shutdown' || pid !== process.pid || typeof nonce !== 'string' ||
      !['SIGINT', 'SIGTERM'].includes(signal)) throw new Error('Invalid shutdown request.');
    const handlerCount = process.listenerCount(signal);
    if (handlerCount === 0) throw new Error('No application shutdown handler.');
    process.prependOnceListener(signal, (observedSignal) => {
      process.send({ type: 'shutdown-observed', pid: process.pid, signal: observedSignal, nonce, handlerCount },
        (error) => {
          if (error) throw error;
          process.disconnect();
        });
    });
    if (process.platform === 'win32') process.emit(signal, signal);
    else process.kill(process.pid, signal);
  });
  process.channel?.unref();
}
const signalBridge = `data:text/javascript,${encodeURIComponent(`(${shutdownBridge.toString()})();`)}`;

// Track output and exit separately so a failed startup has useful context.
// Cleanup also checks that the launched child is gone after each test.
function start(t, entry, args = [], env = {}) {
  const child = fork(entry, args, {
    cwd: root,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', ...env },
    execArgv: ['--import', signalBridge],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  let output = '';
  const shutdowns = new Map();
  child.on('message', (message) => {
    if (message.type === 'shutdown-observed') shutdowns.set(message.nonce, message);
  });
  child.stdout.on('data', (data) => { output += data.toString(); });
  child.stderr.on('data', (data) => { output += data.toString(); });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' }, 'Child process remains alive.');
  });
  return { child, exited, shutdowns, output: () => output };
}

async function until(predicate, description, output, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(25);
  }
  assert.fail(`Timed out waiting for ${description}. ${output()}`);
}

// Match the receipt to this process and request before interpreting its exit
// code. An exit code alone cannot establish which shutdown path ran.
async function stop(processHandle, signal, { nextSignalExit = false } = {}) {
  assert.equal(processHandle.child.exitCode, null, 'Process exited before shutdown was requested.');
  assert.equal(processHandle.child.signalCode, null);
  const nonce = randomUUID();
  await new Promise((resolve, reject) => {
    processHandle.child.send({ type: 'shutdown', pid: processHandle.child.pid, signal, nonce },
      (error) => error ? reject(error) : resolve());
  });
  const receipt = await until(() => processHandle.shutdowns.get(nonce),
    'matching child signal receipt', processHandle.output, 10_000);
  assert.equal(receipt.pid, processHandle.child.pid);
  assert.equal(receipt.signal, signal);
  assert.ok(receipt.handlerCount > 0, 'Application handler must exist before delivery.');
  const result = await Promise.race([
    processHandle.exited,
    delay(10_000, null, { ref: false }).then(() => { throw new Error('Shutdown timed out.'); })
  ]);
  assert.equal(result.signal, null, 'Process must finish through its shutdown handler.');
  if (nextSignalExit) {
    assert.equal(signal, 'SIGTERM');
    assert.match(processHandle.output(), /start-server process cleanup finished/);
    assert.equal(result.code, 128 + constants.signals.SIGTERM, processHandle.output());
  } else {
    assert.equal(result.code, 0, processHandle.output());
  }
}

test('API binds loopback, is live, remains unready, and exposes no business routes', { timeout: 45_000 }, async (t) => {
  const api = start(t, 'apps/api/dist/main.js', [], {
    API_PORT: '0', DATABASE_URL: 'm01-private-canary', MODEL_API_KEY: 'm01-secret-canary'
  });
  const match = await until(() => api.output().match(/http:\/\/127\.0\.0\.1:(\d+)/), 'API startup', api.output);
  const origin = `http://127.0.0.1:${match[1]}`;
  for (const [path, status] of [['/health/live', 200], ['/health/ready', 503], ['/api/v1/ideas', 404]]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, status);
    assert.equal(await response.text(), '');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-powered-by'), null);
    assert.ok(response.headers.get('content-security-policy'));
  }
  assert.equal((await fetch(origin + '/health/ready')).status, 503);
  assert.equal((await fetch(origin + '/api/v1/ideas', { method: 'POST' })).status, 404);
  await stop(api, 'SIGTERM');
  assert.match(api.output(), /API shell stopped\./);
  assert.doesNotMatch(api.output(), /m01-private-canary|m01-secret-canary/);
});

test('invalid API configuration fails without disclosing its value', { timeout: 15_000 }, async (t) => {
  const api = start(t, 'apps/api/dist/main.js', [], { API_PORT: 'm01-invalid-secret-canary' });
  const result = await api.exited;
  assert.equal(result.code, 1);
  assert.match(api.output(), /API configuration invalid\./);
  assert.doesNotMatch(api.output(), /m01-invalid-secret-canary/);
});

for (const app of ['worker', 'dispatcher']) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    test(`${app} independently starts and shuts down through ${signal}`, { timeout: 15_000 }, async (t) => {
      const shell = start(t, `apps/${app}/dist/main.js`);
      await until(() => shell.output().includes('shell started;'), `${app} startup`, shell.output);
      assert.equal(shell.child.exitCode, null);
      await stop(shell, signal);
      assert.match(shell.output(), /shell stopped\./);
    });
  }
}

test('production web renders the public entry and gates the workspace without Clerk configuration', { timeout: 60_000 }, async (t) => {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  const web = start(t, require.resolve('next/dist/bin/next'), [
    'start', 'apps/web', '--hostname', '127.0.0.1', '--port', String(port)
  ], { MODEL_API_KEY: 'm01-web-secret-canary', DEBUG: 'next:start-server' });
  await until(() => /Ready in/.test(web.output()), 'web startup', web.output);
  const response = await fetch(`http://127.0.0.1:${port}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-powered-by'), null);
  const html = await response.text();
  assert.match(html, /Founder(?:&#x27;|&#39;|&apos;|')s Lens/);
  assert.match(html, /href="\/app"[^>]*>Open workspace<\/a>/);
  assert.doesNotMatch(html, /m01-web-secret-canary|fonts\.googleapis|fonts\.gstatic/);
  const workspace = await fetch(`http://127.0.0.1:${port}/app`);
  assert.equal(workspace.status, 200);
  assert.match(await workspace.text(), /Workspace unavailable/);
  await stop(web, 'SIGTERM', { nextSignalExit: true });
  await assert.rejects(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) }));
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
});
