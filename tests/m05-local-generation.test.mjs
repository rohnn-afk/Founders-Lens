// Opt-in HTTP integration composition. Owns disposable Docker resources and
// joins the API, dispatcher and worker through their real persistence adapters.
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { Queue, createIORedisClient } from 'bullmq';
import { PrismaClient } from '../apps/api/dist/generated/prisma/client.js';
import { createSubmissionRepository } from '../apps/api/dist/submission/repository.js';
import { createSubmissionService } from '../apps/api/dist/submission/service.js';
import { submissionRoutes } from '../apps/api/dist/submission/routes.js';
import { createGenerationRepository } from '../apps/api/dist/generation/repository.js';
import { createGenerationService } from '../apps/api/dist/generation/service.js';
import { generationRoutes } from '../apps/api/dist/generation/routes.js';
import { suppressionScopeKey } from '../apps/api/dist/security/suppression-authority.js';
import { dispatcher } from '../apps/dispatcher/dist/dispatch.js';
import { outboxRepository } from '../apps/dispatcher/dist/outbox-repository.js';
import { generationQueue } from '../apps/dispatcher/dist/generation-queue.js';
import { generationRepository } from '../apps/worker/dist/generation-repository.js';
import { generationWorker } from '../apps/worker/dist/generation-worker.js';
import { syntheticContextResponse } from '../apps/worker/dist/generation-context.js';
import { generationConsumer } from '../apps/worker/dist/generation-consumer.js';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const express = require('express');
const { PrismaPg } = require('@prisma/adapter-pg');
const label = 'founders-lens.m05-e2e-run';
const database = 'founders_lens_m05_e2e_test';
const pgImage = 'docker.io/library/postgres:17.12-bookworm@sha256:40865bc877a289da75963d97d72b59633f639fc5af7a4e856bfa3714cae5b536';
const redisImage = 'docker.io/library/redis:7.4.12-bookworm@sha256:2e3eb11462c4e3759e6972678dd051d150ff54b1e60714b3c33b701260172a90';
const checksum = '19fcf7f5f144d1ff39a00a489193392e9deaa60617ebe2f42a8ee576e203032b';
const roles = { api: 'fl_m05_t02_api', worker: 'fl_m05_t02_worker', fixture: 'fl_m05_t02_fixture', dispatch: 'fl_m05_e2e_dispatcher' };
const policy = { operationType: 'generation', unit: 'synthetic_unit', reservationUnits: 1,
  quotaUnits: 6, deadlineMs: 120_000, receiptTtlMs: 120_000 };
const secret = () => randomBytes(32).toString('hex');
const browserMode = process.argv.includes('--browser');
const edge = process.env.WORKSPACE_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browserMessage = 'Browser founder message';
const correction = 'Correction: the pilot serves clinics.';
const correctionMessage = correction + ' ' + 'x'.repeat(1200) + 'outside the bound';
const fixtureMessages = new Set(['Synthetic USER', browserMessage, correctionMessage]);

function restrictedPool(name, credentials) {
  return new Pool({ connectionString: 'postgresql://' + roles[name] + ':' + credentials[name] +
    '@127.0.0.1:55435/' + database, statement_timeout: 5000 });
}

async function loopback(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function unusedPort() {
  const server = createServer();
  const port = await loopback(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function browserJourney({ account, idea, first, url, token, allowed, delivered, setFake, verifyUsage }) {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, 'fl-m05-browser-'));
  const children = [];
  let proxy, socket;
  function child(command, args, cwd) {
    const result = spawn(command, args, { cwd, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' } });
    result.on('error', () => {});
    children.push(result);
    return result;
  }
  try {
    const web = join(root, 'apps', 'web');
    await mkdir(web, { recursive: true });
    await cp('tsconfig.base.json', join(root, 'tsconfig.base.json'));
    for (const entry of ['app', 'features', 'package.json', 'tsconfig.json', 'next.config.ts', 'next-env.d.ts']) {
      await cp(join('apps', 'web', entry), join(web, entry), { recursive: true });
    }
    await symlink(join(process.cwd(), 'node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const source = await readFile('tests/fixtures/m05-workspace-browser.tsx', 'utf8');
    await writeFile(join(web, 'app', 'app', 'layout.tsx'), source.replace('__M05_FIXTURE_ACCOUNT__', account));
    const next = require.resolve('next/dist/bin/next');
    const nextPort = await unusedPort(), edgePort = await unusedPort();
    await promisify(execFile)(process.execPath, [next, 'build', '--webpack'], {
      cwd: web, windowsHide: true, timeout: 120_000, env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' }
    });
    child(process.execPath, [next, 'start', '--hostname', '127.0.0.1', '--port', String(nextPort)], web);
    let loseSubmission = true, pauseStatus = false, archived = false, deny = false, dispatchFailure;
    let nextGeneration;
    const conversationPath = '/conversations/' + first;
    const ideaPath = '/ideas/' + idea;
    const metadata = () => {
      const timestamp = new Date().toISOString();
      const status = archived ? 'ARCHIVED' : 'ACTIVE';
      return { idea: { id: idea, title: 'Synthetic idea', version: 1, status, createdAt: timestamp, updatedAt: timestamp },
        conversation: { id: first, ideaId: idea, title: 'Synthetic conversation', version: 1, status, proactiveResearch: false } };
    };
    const json = (res, status, data) => res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      .end(JSON.stringify(data));
    proxy = createServer(async (req, res) => {
      try {
        const origin = 'http://127.0.0.1:' + proxy.address().port;
        if (req.headers.host !== new URL(origin).host || req.headers['sec-fetch-site'] === 'cross-site' ||
          (req.headers.origin && req.headers.origin !== origin)) return json(res, 403, {});
        const target = new URL(req.url, origin);
        if (target.origin !== origin) return json(res, 403, {});
        if (!target.pathname.startsWith('/__m05/api/')) {
          if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, {});
          const next = await fetch('http://127.0.0.1:' + nextPort + target.pathname + target.search, { redirect: 'manual' });
          res.writeHead(next.status, { 'Content-Type': next.headers.get('content-type') ?? 'application/octet-stream' });
          return res.end(Buffer.from(await next.arrayBuffer()));
        }
        const path = target.pathname.slice('/__m05/api'.length);
        const method = req.method;
        const { idea: fixtureIdea, conversation } = metadata();
        if (method === 'GET' && !target.search) {
          if (path === ideaPath) return json(res, 200, fixtureIdea);
          if (path === conversationPath) return json(res, 200, conversation);
        }
        const attempt = /^\/generations\/([a-f0-9-]{36})(\/cancel)?$/.exec(path);
        const generationRead = attempt && allowed.has(attempt[1]) && !attempt[2] && method === 'GET';
        const cancellation = attempt && allowed.has(attempt[1]) && attempt[2] === '/cancel' && method === 'POST';
        const messages = path === conversationPath + '/messages';
        const correlation = path.startsWith(conversationPath + '/submissions/') &&
          /^[a-f0-9-]{36}$/.test(path.slice((conversationPath + '/submissions/').length));
        const regeneration = path === conversationPath + '/regenerations' && method === 'POST';
        if (!(generationRead || cancellation || (messages && ['GET', 'POST'].includes(method)) ||
          (correlation && method === 'GET') || regeneration) ||
          [...target.searchParams.keys()].some(key => !messages || method !== 'GET' || key !== 'cursor')) return json(res, 404, {});
        if (deny) return json(res, 404, { error: { code: 'NOT_FOUND' } });
        if (pauseStatus && generationRead) {
          res.setHeader('Retry-After', '90');
          return json(res, 429, { error: { code: 'RATE_LIMITED' } });
        }
        const chunks = [];
        let length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 128 * 1024) return json(res, 413, {});
          chunks.push(chunk);
        }
        const reply = await fetch(url + path + target.search, { method,
          headers: { Authorization: 'Bearer ' + token,
            ...(req.headers['idempotency-key'] && { 'Idempotency-Key': req.headers['idempotency-key'] }),
            ...(length && { 'Content-Type': 'application/json' }) },
          body: length ? Buffer.concat(chunks) : undefined, redirect: 'error' });
        const data = await reply.json();
        if (reply.status === 202 && ((messages && method === 'POST') || regeneration)) {
          nextGeneration = messages ? data.generationId : data.id;
          allowed.add(nextGeneration);
          if (messages && loseSubmission) {
            loseSubmission = false;
            return json(res, 500, { error: { code: 'FIXTURE_LOST_ACKNOWLEDGEMENT' } });
          }
        }
        if (reply.headers.has('Retry-After')) res.setHeader('Retry-After', reply.headers.get('Retry-After'));
        return json(res, reply.status, data);
      } catch { return json(res, 503, { error: { code: 'DEPENDENCY_UNAVAILABLE' } }); }
    });
    const port = await loopback(proxy);
    const origin = 'http://127.0.0.1:' + port;
    const route = '/app/ideas/' + idea + '/conversations/' + first;
    await until(async () => (await fetch('http://127.0.0.1:' + nextPort).catch(() => null))?.ok);
    child(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + edgePort,
      '--user-data-dir=' + join(root, 'profile'), 'about:blank']);
    const endpoint = await until(async () => {
      try { return (await (await fetch('http://127.0.0.1:' + edgePort + '/json/list')).json())
        .find(page => page.type === 'page')?.webSocketDebuggerUrl; }
      catch { return false; }
    });
    assert.equal(new URL(endpoint).hostname, '127.0.0.1');
    socket = new WebSocket(endpoint);
    await once(socket, 'open');
    let sequence = 0;
    async function cdp(method, params = {}) {
      const id = ++sequence, result = Promise.withResolvers();
      const timeout = setTimeout(() => result.reject(new Error('Browser command timed out: ' + method)), 6000);
      const receive = event => {
        const data = JSON.parse(event.data);
        if (data.id !== id) return;
        if (data.error) result.reject(new Error(method));
        else result.resolve(data.result);
      };
      socket.addEventListener('message', receive);
      try { socket.send(JSON.stringify({ id, method, params })); return await result.promise; }
      finally { clearTimeout(timeout); socket.removeEventListener('message', receive); }
    }
    async function evaluate(expression) {
      const result = await cdp('Runtime.evaluate', { expression, returnByValue: true });
      if (result.exceptionDetails) throw new Error('Browser assertion could not evaluate');
      return result.result.value;
    }
    const text = value => browserWait(() => evaluate('document.body.innerText.includes(' + JSON.stringify(value) + ')'), value);
    async function browserWait(check, label) {
      for (let attempt = 0; attempt < 160; attempt++) {
        try { const result = await check(); if (result) return result; }
        catch { /* Navigation can briefly replace the execution context. */ }
        await sleep(125);
      }
      const page = await evaluate('document.querySelector("main")?.innerText ?? document.body.innerText');
      throw new Error('Browser did not reach: ' + label + '. View: ' + page.slice(0, 500));
    }
    async function press(name) {
      const selector = '[...document.querySelectorAll("button")].find(b=>b.textContent.trim()===' + JSON.stringify(name) + '&&!b.disabled)';
      await browserWait(() => evaluate('Boolean(' + selector + ')'), name);
      await evaluate(selector + '.focus()');
      assert.equal(await evaluate('document.activeElement.textContent.trim()'), name);
      const space = { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 };
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...space, text: ' ', unmodifiedText: ' ' });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...space });
    }
    await cdp('Page.bringToFront');
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 720, deviceScaleFactor: 1, mobile: true });
    await cdp('Page.navigate', { url: origin + route });
    await text('No saved messages.');
    await evaluate(`(() => {
      const field = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify(browserMessage)});
      field.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await press('Send message');
    await text('Acceptance is unknown.');
    pauseStatus = true;
    await press('Check Again');
    await text('Status observation paused.');
    assert.equal(await evaluate('document.body.innerText.includes("Synthetic assistant")'), false);
    pauseStatus = false;
    await press('Check status');
    await text('Generation pending.');
    const accepted = nextGeneration;
    await delivered(accepted);
    await text('Synthetic assistant');
    await verifyUsage(accepted);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    let release, entered;
    const running = new Promise(resolve => { entered = resolve; });
    setFake(() => new Promise(resolve => { release = resolve; entered(); }));
    await press('Regenerate');
    const replacement = await browserWait(() => nextGeneration !== accepted && nextGeneration, 'regeneration acceptance');
    void delivered(replacement).catch(error => { dispatchFailure = error; });
    await Promise.race([running, sleep(4000).then(() => { throw dispatchFailure ?? new Error('Replacement did not start'); })]);
    assert.equal(await evaluate('document.body.innerText.includes("Synthetic assistant")'), true);
    try {
      await press('Stop');
      await text('Cancellation requested.');
    } finally { release('Uncommitted replacement'); }
    await text('Generation cancelled.');
    await text('Synthetic assistant');
    assert.equal(await evaluate('document.body.innerText.includes("Uncommitted replacement")'), false);
    archived = true;
    await cdp('Page.reload');
    await text('Archived (read only)');
    await text('Synthetic assistant');
    assert.equal(await evaluate('Boolean(document.querySelector("textarea"))'), false);
    deny = true;
    await cdp('Page.reload');
    await text('This workspace item is unavailable.');
    assert.equal(await evaluate('document.body.innerText.includes("Synthetic assistant")'), false);
  } finally {
    socket?.close();
    proxy?.closeAllConnections();
    if (proxy) await new Promise(resolve => proxy.close(resolve));
    for (const process of children.reverse()) {
      if (process.exitCode === null && process.signalCode === null) {
        const finished = once(process, 'exit').catch(() => {});
        process.kill();
        await finished;
      }
    }
    const owned = await realpath(root);
    assert.equal(dirname(owned), temp);
    assert.match(basename(owned), /^fl-m05-browser-[a-zA-Z0-9]+$/);
    await rm(owned, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function docker(args, input) {
  try {
    return execFileSync('docker', args, { input, encoding: 'utf8', windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch { throw new Error('Isolated Docker operation failed: ' + args[0]); }
}

function inspect(id, run, resource, binding, image) {
  const shape = '{{.Id}}|{{.Name}}|{{.Config.Image}}|{{json .Config.Labels}}|{{json .HostConfig.PortBindings}}|{{json .Mounts}}';
  const [actual, name, actualImage, labels, ports, mounts] = docker(['inspect', '--format', shape, id]).split('|');
  assert.deepEqual([actual, name, actualImage, JSON.parse(labels)[label], JSON.parse(ports), JSON.parse(mounts)],
    [id, '/m05-e2e-' + run + '-' + resource, image, run, binding, []]);
}

async function until(check) {
  for (let n = 0; n < 80; n++) {
    const result = await check();
    if (result) return result;
    await sleep(100);
  }
  throw new Error('Timed out waiting for isolated integration state');
}

async function postgres(id, run, credentials) {
  const migration = await readFile('apps/api/prisma/migrations/0001_approved_baseline/migration.sql');
  assert.equal(createHash('sha256').update(migration).digest('hex'), checksum);
  const adminUrl = 'postgresql://bootstrap:' + credentials.bootstrap + '@127.0.0.1:55435/' + database;
  const admin = new Pool({ connectionString: adminUrl, connectionTimeoutMillis: 300, max: 1 });
  try {
    await until(() => admin.query('SELECT 1').catch(() => false));
    const { rows: [identity] } = await admin.query(`SELECT current_database() AS db, current_user AS role,
      current_setting('server_version_num')::int/10000 AS major`);
    assert.deepEqual(identity, { db: database, role: 'bootstrap', major: 17 });
    await admin.query('BEGIN');
    try {
      await admin.query(migration.toString());
      await admin.query(`CREATE TABLE "_prisma_migrations" (id varchar(36) primary key, checksum varchar(64) not null,
        finished_at timestamptz, migration_name varchar(255) not null, logs text, rolled_back_at timestamptz,
        started_at timestamptz not null default now(), applied_steps_count integer not null default 0)`);
      await admin.query('INSERT INTO "_prisma_migrations" (id,checksum,migration_name,finished_at,applied_steps_count) VALUES ($1,$2,$3,now(),1)',
        [randomUUID(), checksum, '0001_approved_baseline']);
      // Identifiers are fixed and generated secrets are hex, never caller input.
      await admin.query(`COMMENT ON DATABASE ${database} IS 'isolated M05-E2E run ${run}';
        REVOKE CONNECT ON DATABASE postgres,template1,${database} FROM PUBLIC`);
      for (const [key, role] of Object.entries(roles)) {
        await admin.query(`CREATE ROLE ${role} LOGIN NOINHERIT PASSWORD '${credentials[key]}';
          GRANT CONNECT ON DATABASE ${database} TO ${role}`);
      }
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    }
    await admin.query(await readFile('tests/m05-local-generation-grants.sql', 'utf8'));
    await admin.query(await readFile('tests/m05-t02-bootstrap.sql', 'utf8'));
    // Prove that the baseline and earlier test grants expose no context reader.
    const worker = restrictedPool('worker', credentials);
    try {
      const { rows: [identity] } = await worker.query('SELECT current_user AS role,current_database() AS db');
      assert.deepEqual(identity, { role: roles.worker, db: database });
      await assert.rejects(worker.query('SELECT m06_context.read_attempt($1,$2,$3,$4)',
        [randomUUID(), 1, 0, Date.now() + 1000]), { code: '3F000' });
    } finally { await worker.end(); }
    await admin.query(await readFile('tests/m06-context-bootstrap.sql', 'utf8'));
    assert.equal((await admin.query('SELECT checksum FROM "_prisma_migrations"')).rows[0].checksum, checksum);
    await admin.query('ALTER ROLE bootstrap NOLOGIN PASSWORD NULL');
    docker(['exec', id, 'rm', '/tmp/bootstrap']);
  } finally { await admin.end(); }
}

async function verify(pool, name, run) {
  const { rows: [row] } = await pool.query(`SELECT current_user AS role,current_database() AS db,
    shobj_description((SELECT oid FROM pg_database WHERE datname=current_database()),'pg_database') AS run,
    has_column_privilege('public."Message"','content','SELECT') AS content,
    has_column_privilege('public."GenerationAttempt"','orchestrationMetadata','SELECT') AS metadata,
    has_column_privilege('public."UsageLedger"','reservationState','UPDATE') AS settlement,
    has_schema_privilege('public','CREATE') AS ddl, has_database_privilege('postgres','CONNECT') AS cross_db,
    (SELECT rolcanlogin FROM pg_roles WHERE rolname='bootstrap') AS bootstrap,
    (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='t02_receipts' AND has_function_privilege(current_user,p.oid,'EXECUTE')) AS functions`);
  assert.deepEqual(row, { role: roles[name], db: database, run: 'isolated M05-E2E run ' + run,
    content: name === 'api', metadata: false, settlement: name === 'worker', ddl: false,
    cross_db: false, bootstrap: false, functions: name === 'worker' ? 2 : name === 'fixture' ? 1 : 0 });
  await assert.rejects(pool.query('SELECT "orchestrationMetadata" FROM "GenerationAttempt" WHERE false'), { code: '42501' });
  await assert.rejects(pool.query('SELECT "currentContent" FROM "ConfirmedMemory" WHERE false'), { code: '42501' });
  await assert.rejects(pool.query('SELECT content FROM "MemoryRevision" WHERE false'), { code: '42501' });
  if (name !== 'worker') {
    await assert.rejects(pool.query('SELECT m06_context.read_attempt(NULL,1,1,1)'), { code: '42501' });
  } else {
    const { rows: [definer] } = await pool.query(`SELECT r.rolcanlogin,r.rolinherit,r.rolsuper,r.rolbypassrls,p.prosecdef,
      p.proconfig, has_function_privilege(current_user,p.oid,'EXECUTE') AS execute
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
      WHERE n.nspname='m06_context' AND p.proname='read_attempt'`);
    assert.deepEqual(definer, { rolcanlogin: false, rolinherit: false, rolsuper: false,
      rolbypassrls: false, prosecdef: true, proconfig: ['search_path=pg_catalog, pg_temp'], execute: true });
  }
  if (name !== 'api') await assert.rejects(pool.query('SELECT content FROM "Message" WHERE false'), { code: '42501' });
  if (name !== 'worker') {
    await assert.rejects(pool.query(`UPDATE "UsageLedger" SET "reservationState"='RELEASED' WHERE false`), { code: '42501' });
    await assert.rejects(pool.query('SELECT t02_receipts.record_usage(NULL,1)'), { code: '42501' });
  }
}

async function exercise({ pools, redisUrl, prefix, queue, prisma, run, startServer, startConsumer }) {
  const { fixture } = pools;
  const account = randomUUID(), idea = randomUUID(), first = randomUUID(), second = randomUUID();
  const subject = 'fixture-' + account, instance = 'm05-t02-fixture';
  const digest = createHash('sha256').update(subject).digest('hex');
  await fixture.query('INSERT INTO "UserAccount" (id,"clerkSubject","clerkInstanceId","subjectKey","updatedAt") VALUES ($1,$2,$3,$4,now())',
    [account, subject, instance, digest]);
  await fixture.query('INSERT INTO "Idea" (id,"ownerId",title,"updatedAt") VALUES ($1,$2,\'Synthetic idea\',now())', [idea, account]);
  await fixture.query('INSERT INTO "Conversation" (id,"ideaId","updatedAt") VALUES ($1,$3,now()),($2,$3,now())', [first, second, idea]);
  const principal = { localUserId: account, clerkSubject: subject, clerkInstanceId: instance, accountStatus: 'ACTIVE',
    subjectKeys: [{ version: 1, digest }] };
  const accountScope = JSON.stringify(['ACCOUNT', instance, 1, digest, 'ALL']);
  const ideaScope = JSON.stringify(['IDEA', instance, account, idea]);
  const evidence = (scope, { nonce }) => {
    if (scope !== accountScope && scope !== ideaScope) return null;
    const now = Date.now();
    return { scope, nonce, verdict: 'CLEAR', observedAt: now, validUntil: now + 2000 };
  };
  const apiAuthority = { async lookup(scope, query) {
    const proof = evidence(suppressionScopeKey(scope), query);
    return proof && { ...proof, integrity: 'VERIFIED', coverage: 'COMPLETE', authority: 'INDEPENDENT', epoch: run };
  } };
  const fixtureToken = 'test.' + secret() + '.fixture';
  const authenticate = async request => request.get('authorization') === 'Bearer ' + fixtureToken ? principal : null;
  const app = express();
  // The browser proxy can submit on behalf of the fixture. Allow only the
  // scripted message text even if someone manually opens the loopback page.
  app.post('/api/v1/conversations/:conversationId/messages', express.json({ limit: '128kb' }), (req, res, next) => {
    if (!fixtureMessages.has(req.body?.content)) {
      return res.status(400).json({ error: { code: 'FIXTURE_INPUT_DENIED' } });
    }
    next();
  });
  app.use('/api/v1', submissionRoutes(createSubmissionService(createSubmissionRepository(prisma), apiAuthority,
    { clock: () => new Date(), policy, cursorSecret: randomBytes(32) }), authenticate));
  app.use('/api/v1', generationRoutes(createGenerationService(createGenerationRepository(prisma, policy), apiAuthority), authenticate));
  const server = app.listen(0, '127.0.0.1');
  startServer(server);
  await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port + '/api/v1';
  async function request(path, expected, { method = 'GET', key, body } = {}) {
    const response = await fetch(url + path, { method, headers: { Authorization: 'Bearer ' + fixtureToken,
      ...(key && { 'Idempotency-Key': key }), ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, expected, result.error?.code);
    return result;
  }
  const convo = id => '/conversations/' + id;
  const submit = (id, expected = 202, key = randomUUID(), body = { clientSubmissionId: randomUUID(), content: 'Synthetic USER' }) =>
    request(convo(id) + '/messages', expected, { method: 'POST', key, body });
  const status = id => request('/generations/' + id, 200);
  const cancel = (id, expected = 202) => request('/generations/' + id + '/cancel', expected, { method: 'POST', key: randomUUID() });
  const history = id => request(convo(id) + '/messages', 200);
  const row = async (table, id) => (await fixture.query('SELECT id,status FROM "' + table + '" WHERE id=$1', [id])).rows[0];
  const ledger = async id => (await fixture.query('SELECT "reservationState","measuredUnits" FROM "UsageLedger" WHERE "reservationId"=$1',
    [id])).rows[0];
  const outbox = async id => {
    const { rows } = await fixture.query('SELECT id,status,"lastErrorCode" FROM "OutboxEvent" WHERE "aggregateId"=$1', [id]);
    assert.equal(rows.length, 1);
    return rows[0];
  };

  let fake, lastContext, expire = false, dispatchDenied = false, executions = 0;
  const allowed = new Set(), work = generationRepository(pools.worker);
  const worker = generationWorker(work, async (scope, query) => {
    const proof = evidence(scope, query);
    return expire && proof ? { ...proof, validUntil: proof.observedAt } : proof;
  }, id => allowed.has(id), undefined, Date.now, async context => {
    executions++;
    lastContext = context;
    return fake ? fake() : syntheticContextResponse(context);
  });
  const consumer = generationConsumer(redisUrl, prefix, worker);
  startConsumer(consumer);
  await consumer.waitUntilReady();

  async function poll(id) {
    const { id: eventId } = await outbox(id);
    allowed.add(id);
    const repository = outboxRepository(pools.dispatch, [eventId]);
    const pump = dispatcher(repository, generationQueue(redisUrl, prefix),
      async (scope, query) => dispatchDenied ? null : evidence(scope, query), () => {});
    try { await pump.poll(); } finally { await pump.close(); }
    return eventId;
  }
  async function delivered(id) {
    await poll(id);
    assert.equal((await outbox(id)).status, 'PUBLISHED');
    const job = await queue.getJob(id);
    assert.equal(job.name, 'generation.requested');
    assert.deepEqual(job.data, { generationId: id });
    return job;
  }
  async function terminal(id, state) {
    return until(async () => {
      const value = await status(id);
      return value.status === state && value;
    });
  }

  if (browserMode) {
    return browserJourney({ account, idea, first, url, token: fixtureToken, allowed, delivered,
      setFake: next => { fake = next; },
      async verifyUsage(id) {
        const completed = await status(id);
        assert.ok(completed.selected && completed.outputMessageId);
        assert.deepEqual(await ledger(id), { reservationState: 'SETTLED', measuredUnits: '1.00000' });
        assert.equal((await fixture.query('SELECT id FROM "Message" WHERE "conversationId"=$1', [first])).rowCount, 2);
      } });
  }

  const key = randomUUID(), body = { clientSubmissionId: randomUUID(), content: 'Synthetic USER' };
  assert.equal((await submit(first, 400, randomUUID(),
    { clientSubmissionId: randomUUID(), content: 'Unscripted test sentinel' })).error.code, 'FIXTURE_INPUT_DENIED');
  assert.deepEqual((await history(first)).items, []);
  const admitted = await submit(first, 202, key, body);
  const id = admitted.generationId;
  assert.deepEqual(await submit(first, 202, key, body), admitted);
  assert.equal((await status(id)).status, 'PENDING');
  assert.equal((await outbox(id)).status, 'PENDING');
  assert.equal((await ledger(id)).reservationState, 'RESERVED');
  assert.equal((await fixture.query('SELECT id FROM "IdempotencyRecord" WHERE "accountId"=$1', [account])).rowCount, 1);
  assert.equal((await fixture.query('SELECT id FROM "Message" WHERE "conversationId"=$1', [first])).rowCount, 1);
  const job = await delivered(id);
  const completed = await terminal(id, 'COMPLETED');
  assert.equal(completed.selected, true);
  await until(async () => (await job.getState()) === 'completed');
  await poll(id);
  // Re-exercise the worker's duplicate-delivery gate with the real broker
  // envelope. The dispatcher remains the only publisher in this harness.
  await worker.process(job);
  assert.equal(executions, 1);
  assert.equal((await cancel(id, 200)).status, 'COMPLETED');
  assert.deepEqual(await ledger(id), { reservationState: 'SETTLED', measuredUnits: '1.00000' });
  const initialTranscript = (await history(first)).items;
  assert.deepEqual(initialTranscript.map(item => item.role), ['USER', 'ASSISTANT']);
  assert.equal(initialTranscript[0].content, body.content);
  assert.match(initialTranscript[1].content, /Current founder statement: .*Synthetic USER/);

  fake = async () => 'Regenerated synthetic assistant';
  const regenKey = randomUUID();
  const regenRequest = () => request(convo(first) + '/regenerations', 202, { method: 'POST', key: regenKey,
    body: { triggerMessageId: admitted.messageId } });
  const regenerated = await regenRequest();
  assert.equal((await status(id)).selected, true);
  await delivered(regenerated.id);
  const replacement = await terminal(regenerated.id, 'COMPLETED');
  assert.deepEqual(await regenRequest(), regenerated);
  assert.equal((await status(id)).selected, false);
  assert.equal((await history(first)).items.at(-1).content, 'Regenerated synthetic assistant');

  async function seedMemory(ideaId, message, state = 'ACTIVE', actor = account) {
    const memory = randomUUID(), content = { text: message };
    await fixture.query(`INSERT INTO "ConfirmedMemory" (id,"ideaId",kind,"currentContent",status,"updatedAt")
      VALUES ($1,$2,'FACT',$3,$4,now())`, [memory, ideaId, content, state]);
    await fixture.query(`INSERT INTO "MemoryRevision" (id,"memoryId",version,content,"actorId")
      VALUES ($1,$2,1,$3,$4)`, [randomUUID(), memory, content, actor]);
    return memory;
  }
  const otherIdea = randomUUID();
  await fixture.query('INSERT INTO "Idea" (id,"ownerId",title,"updatedAt") VALUES ($1,$2,$3,now())',
    [otherIdea, account, 'Other synthetic idea']);
  const reviewed = await seedMemory(idea, 'Reviewed channel is referrals');
  await seedMemory(otherIdea, 'Other idea confidential marker');
  const foreign = randomUUID(), foreignIdea = randomUUID();
  await fixture.query('INSERT INTO "UserAccount" (id,"clerkSubject","clerkInstanceId","subjectKey","updatedAt") VALUES ($1,$2,$3,$4,now())',
    [foreign, 'fixture-' + foreign, instance, createHash('sha256').update(foreign).digest('hex')]);
  await fixture.query('INSERT INTO "Idea" (id,"ownerId",title,"updatedAt") VALUES ($1,$2,$3,now())',
    [foreignIdea, foreign, 'Foreign synthetic idea']);
  await seedMemory(foreignIdea, 'Foreign account confidential marker', 'ACTIVE', foreign);
  await fixture.query(`INSERT INTO "MemoryProposal" (id,"ideaId",kind,candidate)
    VALUES ($1,$2,'FACT',$3)`, [randomUUID(), idea, { text: 'Pending confidential marker' }]);
  fake = undefined;
  const followUp = await submit(first, 202, randomUUID(),
    { clientSubmissionId: randomUUID(), content: correctionMessage });
  await delivered(followUp.generationId);
  await terminal(followUp.generationId, 'COMPLETED');
  assert.equal(lastContext.current.id, followUp.messageId);
  assert.equal(lastContext.current.text.length, 1200);
  assert.equal(lastContext.current.truncated, true);
  assert.deepEqual(lastContext.previous.map(turn => [turn.user.id, turn.assistant?.id]),
    [[admitted.messageId, replacement.outputMessageId]]);
  assert.deepEqual(lastContext.memory.map(item => item.id), [reviewed]);
  const answer = (await history(first)).items.at(-1).content;
  assert.ok(answer.includes(correction));
  assert.ok(answer.includes('Reviewed channel is referrals'));
  assert.doesNotMatch(answer, /confidential marker|outside the bound/);
  assert.notEqual(answer, initialTranscript[1].content);
  assert.deepEqual(await ledger(followUp.generationId), { reservationState: 'SETTLED', measuredUnits: '1.00000' });

  const earlySubmission = await submit(second);
  const early = earlySubmission.generationId;
  assert.equal((await cancel(early)).status, 'CANCEL_REQUESTED');
  await poll(early);
  assert.equal(await queue.getJob(early), undefined);
  await worker.recover([early]);
  assert.equal((await status(early)).status, 'CANCELLED');
  assert.equal((await ledger(early)).reservationState, 'RELEASED');

  let entered, resume;
  const started = new Promise(resolve => { entered = resolve; });
  fake = () => new Promise(resolve => { resume = resolve; entered(); });
  const during = (await submit(second)).generationId;
  await delivered(during);
  await Promise.race([started, sleep(4000).then(() => { throw new Error('Fake did not start'); })]);
  assert.deepEqual(lastContext.previous.map(turn => [turn.user.id, turn.assistant?.id]), [[earlySubmission.messageId, undefined]]);
  assert.deepEqual(lastContext.memory.map(item => item.id), [reviewed]);
  assert.equal((await status(during)).status, 'RUNNING');
  try {
    const active = await work.scope(during);
    const { rows: [{ leaseEpoch }] } = await fixture.query('SELECT "leaseEpoch" FROM "GenerationAttempt" WHERE id=$1', [during]);
    const read = (id, epoch, contextEpoch, expiry = Date.now() + 1000) => pools.worker.query(
      'SELECT m06_context.read_attempt($1,$2,$3,$4) AS context', [id, epoch, contextEpoch, expiry])
      .then(({ rows }) => rows[0].context);
    assert.equal(await read(during, leaseEpoch, active.contextEpoch + 1), null);
    assert.equal(await read(during, leaseEpoch + 1, active.contextEpoch), null);
    assert.equal(await read(during, leaseEpoch, active.contextEpoch, Date.now() - 1), null);
    assert.equal(await work.readContext({ ...active, accountId: foreign }, leaseEpoch, Date.now() + 1000), undefined);
    const removed = await seedMemory(idea, 'Removed confidential marker', 'REMOVED');
    assert.notEqual(removed, reviewed);
    const visible = await read(during, leaseEpoch, active.contextEpoch);
    assert.deepEqual(visible.previous, []);
    assert.deepEqual(visible.memory.map(item => item.id), [reviewed]);
    const deletion = randomUUID();
    await fixture.query(`INSERT INTO "DataOperation"
      (id,"accountId","ideaId",kind,"deadlineAt","clerkInstanceId","ownerSubjectKey","deletionScopeKey","deletionState","policyVersion")
      VALUES ($1,$2,$3,'DELETE_IDEA',now()+interval '120 seconds',$4,$5,$6,'DELETION_REQUESTED','synthetic')`,
    [deletion, account, idea, instance, digest, 'context:' + run]);
    try { assert.equal(await read(during, leaseEpoch, active.contextEpoch), null); }
    finally { await fixture.query('DELETE FROM "DataOperation" WHERE id=$1', [deletion]); }
    assert.equal((await cancel(during)).status, 'CANCEL_REQUESTED');
  }
  finally { resume('Discarded by cancellation'); }
  await terminal(during, 'CANCELLED');
  assert.equal((await ledger(during)).reservationState, 'SETTLED');
  assert.equal((await fixture.query('SELECT id FROM "Message" WHERE "generationAttemptId"=$1', [during])).rowCount, 0);

  fake = async () => { expire = true; return 'Discarded after clearance expiry'; };
  const known = (await submit(second)).generationId;
  dispatchDenied = true;
  const deniedEvent = await poll(known);
  assert.equal(await queue.getJob(known), undefined);
  assert.equal((await outbox(known)).lastErrorCode, 'SUPPRESSION_UNAVAILABLE');
  await fixture.query('UPDATE "OutboxEvent" SET "nextAttemptAt"=now() WHERE id=$1', [deniedEvent]);
  dispatchDenied = false;
  const knownJob = await delivered(known);
  await until(async () => (await knownJob.getState()) === 'completed');
  expire = false;
  assert.equal((await status(known)).status, 'RUNNING');
  const scope = await work.scope(known);
  const { rows: [attempt] } = await fixture.query('SELECT "leaseEpoch" FROM "GenerationAttempt" WHERE id=$1', [known]);
  assert.equal((await ledger(known)).reservationState, 'RESERVED');
  const expireLease = id => fixture.query('UPDATE "GenerationAttempt" SET "leaseUntil"=now()-interval \'1 second\' WHERE id=$1', [id]);
  await expireLease(known);
  assert.equal(await work.readContext(scope, attempt.leaseEpoch, Date.now() + 1000), undefined);
  assert.equal(await work.heartbeat(scope, attempt.leaseEpoch), false);
  await worker.recover([known]);
  await worker.recover([known]);
  assert.equal((await status(known)).status, 'FAILED');
  assert.deepEqual(await ledger(known), { reservationState: 'SETTLED', measuredUnits: '1.00000' });
  assert.equal((await fixture.query('SELECT id FROM "Message" WHERE "generationAttemptId"=$1', [known])).rowCount, 0);

  const unknown = (await submit(second)).generationId;
  const event = await outbox(unknown);
  const due = () => fixture.query('UPDATE "OutboxEvent" SET "nextAttemptAt"=now() WHERE id=$1', [event.id]);
  const claims = outboxRepository(pools.dispatch, [event.id]);
  const { events: [stale] } = await claims.claim();
  await fixture.query('UPDATE "OutboxEvent" SET "leaseUntil"=now()-interval \'1 second\' WHERE id=$1', [event.id]);
  const { events: [current] } = await claims.claim();
  assert.equal(current.claimEpoch, stale.claimEpoch + 1);
  assert.equal(await claims.acknowledge(stale), false);
  assert.equal(await claims.fail(current, 'INELIGIBLE', 0), 'PENDING');
  // An otherwise valid intent must fail if the fixture supplies an unused
  // column. Confirm the denial leaves both the deletion and dispatch state intact.
  const deniedOperation = randomUUID();
  const beforeDeniedInsert = await outbox(unknown);
  await assert.rejects(fixture.query(`INSERT INTO "DataOperation"
    (id,"accountId","ideaId",kind,"deadlineAt","clerkInstanceId","ownerSubjectKey","deletionScopeKey","deletionState","policyVersion",status)
    VALUES ($1,$2,$3,'DELETE_IDEA',now()+interval '120 seconds',$4,$5,$6,'DELETION_REQUESTED','synthetic','REQUESTED')`,
  [deniedOperation, account, idea, instance, digest, 'denied:' + run]), { code: '42501' });
  assert.equal((await fixture.query('SELECT id FROM "DataOperation" WHERE id=$1', [deniedOperation])).rowCount, 0);
  assert.deepEqual(await outbox(unknown), beforeDeniedInsert);
  for (const kind of ['DELETE_IDEA', 'DELETE_ACCOUNT']) {
    const operation = randomUUID();
    const inserted = await fixture.query(`INSERT INTO "DataOperation"
      (id,"accountId","ideaId",kind,"deadlineAt","clerkInstanceId","ownerSubjectKey","deletionScopeKey","deletionState","policyVersion")
      VALUES ($1,$2,$3,$4,now()+interval '120 seconds',$5,$6,$7,'DELETION_REQUESTED','synthetic')`,
    [operation, account, kind === 'DELETE_IDEA' ? idea : null, kind, instance, digest, kind + ':' + run]);
    assert.equal(inserted.rowCount, 1);
    try {
      await due();
      await poll(unknown);
      assert.equal(await queue.getJob(unknown), undefined);
      assert.equal((await outbox(unknown)).lastErrorCode, 'INELIGIBLE');
    } finally { await fixture.query('DELETE FROM "DataOperation" WHERE id=$1', [operation]); }
  }
  await due();
  fake = async () => { throw new Error('Synthetic uncertain invocation'); };
  const unknownJob = await delivered(unknown);
  await until(async () => (await unknownJob.getState()) === 'completed');
  await expireLease(unknown);
  await worker.recover([unknown]);
  await worker.recover([unknown]);
  assert.equal((await row('GenerationAttempt', unknown)).status, 'FAILED');
  assert.equal((await ledger(unknown)).reservationState, 'RESERVED');
  assert.equal((await submit(first, 429)).error.code, 'QUOTA_EXCEEDED');
}

test('isolated HTTP submission through outbox, BullMQ and the fake generation worker', {
  skip: !process.argv.includes('--live'), timeout: browserMode ? 240_000 : 120_000
}, async t => {
  if (browserMode && !await access(edge).then(() => true, () => false)) {
    t.skip('Edge executable is unavailable');
    return;
  }
  const run = randomUUID(), prefix = 'founders-lens-m05-e2e-' + run;
  const network = 'm05-e2e-' + run;
  const credentials = Object.fromEntries([...Object.keys(roles), 'bootstrap', 'redis'].map(name => [name, secret()]));
  const redisUrl = new URL('redis://:' + credentials.redis + '@127.0.0.1:56381/0');
  const pools = {}, containers = [];
  let networkId, redis, queue, consumer, prisma, server;
  function start(resource, image, hostPort, containerPort, tmpfs, options, command) {
    const binding = { [containerPort + '/tcp']: [{ HostIp: '127.0.0.1', HostPort: hostPort }] };
    const id = docker(['run', '-d', '--pull=never', '--network', networkId, '--name', network + '-' + resource,
      '--label', label + '=' + run, '-p', '127.0.0.1:' + hostPort + ':' + containerPort,
      '--tmpfs', tmpfs, ...options, image, ...command]);
    containers.push({ id, resource, image, binding });
    inspect(id, run, resource, binding, image);
    return id;
  }
  try {
    networkId = docker(['network', 'create', '--label', label + '=' + run, network]);
    const pgId = start('pg', pgImage, '55435', '5432', '/var/lib/postgresql/data:rw,nosuid,nodev,mode=0700',
      ['-e', 'POSTGRES_USER=bootstrap', '-e', 'POSTGRES_DB=' + database, '-e', 'POSTGRES_PASSWORD_FILE=/tmp/bootstrap',
        '--entrypoint', 'sh'], ['-ec', 'while [ ! -s /tmp/bootstrap ]; do sleep 1; done; exec docker-entrypoint.sh postgres']);
    docker(['exec', '-i', pgId, 'sh', '-ec', 'umask 077; cat > /tmp/bootstrap-new; mv /tmp/bootstrap-new /tmp/bootstrap'],
      credentials.bootstrap);
    await postgres(pgId, run, credentials);
    const redisId = start('redis', redisImage, '56381', '6379', '/data:rw,noexec,nosuid,nodev,mode=1777',
      ['--entrypoint', 'sh'], ['-ec', 'while [ ! -s /tmp/run-config ]; do sleep 1; done; exec redis-server /tmp/run-config']);
    docker(['exec', '-i', redisId, 'sh', '-ec', 'umask 077; cat > /tmp/run-config-new; mv /tmp/run-config-new /tmp/run-config'],
      'bind 0.0.0.0\nprotected-mode yes\nrequirepass ' + credentials.redis + '\nsave ""\nappendonly no\n');
    for (const name of Object.keys(roles)) {
      pools[name] = restrictedPool(name, credentials);
      await verify(pools[name], name, run);
    }
    redis = new Redis(redisUrl.href, { maxRetriesPerRequest: 0, connectTimeout: 1000 });
    redis.on('error', () => {});
    await until(() => redis.ping().catch(() => false));
    assert.equal((await redis.info('keyspace')).trim(), '# Keyspace');
    assert.equal((await redis.client('LIST')).trim().split('\n').length, 1);
    const liveBroker = (await redis.info('server')).match(/^run_id:(\w+)/m)?.[1];
    assert.ok(liveBroker);
    queue = new Queue('generation', { prefix, connection: createIORedisClient(redis) });
    const apiUrl = 'postgresql://' + roles.api + ':' + credentials.api + '@127.0.0.1:55435/' + database;
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: apiUrl, statement_timeout: 5000 }) });
    await exercise({ pools, redisUrl, prefix, queue, prisma, run, startServer: value => { server = value; },
      startConsumer: value => { consumer = value; } });
    assert.equal((await redis.info('server')).match(/^run_id:(\w+)/m)?.[1], liveBroker);
  } finally {
    try {
      if (server) await new Promise(resolve => server.close(resolve));
      await consumer?.close();
      await queue?.close();
      redis?.disconnect();
      await prisma?.$disconnect();
      await Promise.all(Object.values(pools).map(pool => pool.end()));
    } finally {
      // The entire disposable cluster is the fixture. Reverify every ID
      // before removal, and never delete a volume or an existing service.
      for (const { id, resource, binding, image } of containers.reverse()) {
        inspect(id, run, resource, binding, image);
        docker(['rm', '-f', id]);
      }
      if (networkId) {
        assert.equal(docker(['network', 'inspect', '--format', '{{index .Labels "' + label + '"}}', networkId]), run);
        docker(['network', 'rm', networkId]);
      }
    }
  }
});
