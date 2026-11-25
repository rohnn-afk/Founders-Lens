import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { chromium } from 'playwright';

const hosted = process.argv.includes('--hosted');
const hostedOrigin = 'https://founders-lens-staging-api.onrender.com';

test('Swagger renders the guarded workspace operations and offers no API execution', { timeout: 65_000 }, async t => {
  let origin = hostedOrigin;
  if (!hosted) {
    const { createApp } = await import('../apps/api/dist/app.js');
    const { stagingReadRoutes } = await import('../apps/api/dist/workspace/staging-composition.js');
    const forbidden = () => assert.fail('The reference must not execute a workspace handler');
    const router = stagingReadRoutes('https://workspace.example', forbidden, { ideas: forbidden }, {
      idea: forbidden, conversations: forbidden, conversation: forbidden, history: forbidden
    });
    const server = createApp(router).listen(0, '127.0.0.1');
    t.after(() => new Promise(resolve => server.close(resolve)));
    await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  }

  const browser = await chromium.launch({ channel: process.env.SWAGGER_BROWSER_CHANNEL || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const attempted = [];
  await page.route('**/api/v1/**', async route => {
    attempted.push(new URL(route.request().url()).pathname);
    await route.abort();
  });
  const failure = page.getByText('Failed to load API definition.', { exact: true });
  const specRequest = Promise.race([
    page.waitForResponse(response => response.url() === origin + '/openapi.json', { timeout: 45_000 }),
    failure.waitFor({ timeout: 45_000 }).then(() => assert.fail('Swagger displayed a definition loading error'))
  ]);
  // Both promises are observed if navigation or Swagger fails.
  const [spec, doc] = await Promise.all([specRequest, page.goto(origin + '/docs', { timeout: 45_000 })]);
  assert.equal(doc?.status(), 200);
  assert.equal(spec.status(), 200);
  assert.equal(spec.request().method(), 'GET');

  const operation = page.locator('[id="operations-Ideas-listIdeas"]');
  await operation.locator('.opblock-summary-control').click();
  await operation.getByText('List owned ideas', { exact: true }).waitFor();
  await operation.getByText('Successful response', { exact: true }).waitFor();
  assert.equal(await failure.count(), 0);
  assert.equal(await page.locator('.opblock').count(), 7);
  assert.equal(await page.getByRole('button', { name: /try it out|execute|authorize/i }).count(), 0);
  assert.deepEqual(attempted, []);
});
