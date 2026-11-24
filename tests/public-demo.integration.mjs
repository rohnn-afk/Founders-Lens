import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const web = fileURLToPath(new URL('../apps/web/', import.meta.url));
const require = createRequire(import.meta.url);

test('the public build serves its preview and denies private routes with no upstream traffic', { timeout: 30_000 }, async (t) => {
  let upstreamRequests = 0;
  const upstream = createServer((_, response) => {
    upstreamRequests++;
    response.writeHead(200).end();
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => upstream.close());

  const secret = 'demo-test-private-sentinel';
  const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '--port', '0',
    '--hostname', '127.0.0.1'], {
    cwd: web,
    env: {
      ...process.env,
      FL_PUBLIC_DEMO: 'false',
      CLERK_SECRET_KEY: secret,
      NEXT_PUBLIC_FL_API_ORIGIN: `http://127.0.0.1:${upstream.address().port}`,
      NEXT_TELEMETRY_DISABLED: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    child.kill();
    await exited;
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  let origin;
  for (let i = 0; !origin && i < 200 && child.exitCode === null; i++) {
    origin = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (!origin) await delay(50);
  }
  assert.ok(origin, 'Next.js did not publish a loopback address');

  const landing = await fetch(origin, { redirect: 'error' });
  assert.equal(landing.status, 200);
  const html = await landing.text();
  assert.match(html, /Think clearly about what to build next/);
  assert.match(html, /Illustrative conversation/);
  assert.match(html, /href="#preview"/);
  assert.match(html, /id="preview"/);
  assert.match(html, /href="https:\/\/github\.com\/rohnn-afk\/Founders-Lens"/);
  assert.match(html, /property="og:title"/);
  assert.doesNotMatch(html, /Open workspace|clerk\.browser|demo-test-private-sentinel/);

  const styles = new Set(Array.from(html.matchAll(/href="(\/_next\/static\/[^"]+\.css)"/g), match => match[1]));
  let stylesheets = '';
  for (const asset of styles) {
    const css = await fetch(origin + asset);
    assert.equal(css.status, 200);
    stylesheets += await css.text();
  }
  assert.match(stylesheets, /@media[^{}]+46rem/);
  for (const [, asset] of html.matchAll(/src="(\/_next\/static\/[^"]+\.js)"/g)) {
    const script = await fetch(origin + asset);
    assert.equal(script.status, 200);
    assert.ok(!(await script.text()).includes(secret));
  }

  for (const route of ['/app', '/app/ideas/example/think',
    '/app/ideas/example/conversations/sample', '/sign-in', '/sign-in/sso-callback', '/__clerk/session', '/api/v1/messages']) {
    const response = await fetch(origin + route, { redirect: 'manual' });
    assert.equal(response.status, 404, route);
    assert.ok(!(await response.text()).includes(secret));
  }
  const submission = await fetch(origin + '/app', { method: 'POST', redirect: 'manual' });
  assert.equal(submission.status, 404);
  assert.match(await (await fetch(origin + '/unknown-page')).text(), /Page not found/);
  assert.equal((await fetch(origin + '/health/live')).status, 200);
  assert.equal((await fetch(origin + '/health/ready')).status, 200);
  assert.equal(upstreamRequests, 0);
  assert.ok(!output.includes(secret));
});
