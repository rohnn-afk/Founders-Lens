// Opt-in HTTP integration composition. Owns disposable Docker resources and
// joins the API, dispatcher and worker through their real persistence adapters.
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import { leasedContextReader } from '../apps/worker/dist/leased-context-reader.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { Queue, createIORedisClient } from 'bullmq';
import { PrismaClient } from '../apps/api/dist/generated/prisma/client.js';
import { createSubmissionRepository } from '../apps/api/dist/submission/repository.js';
import { createSubmissionService } from '../apps/api/dist/submission/service.js';
import { localGenerationPolicy } from '../apps/api/dist/generation/local-policy.js';
import { submissionRoutes } from '../apps/api/dist/submission/routes.js';
import { createGenerationRepository } from '../apps/api/dist/generation/repository.js';
import { createGenerationService } from '../apps/api/dist/generation/service.js';
import { generationRoutes } from '../apps/api/dist/generation/routes.js';
import { localConversationOperations } from '../apps/api/dist/workspace/local-conversations.js';
import { localConversationRoutes } from '../apps/api/dist/workspace/routes.js';
import { suppressionScopeKey } from '../apps/api/dist/security/suppression-authority.js';
import { dispatcher } from '../apps/dispatcher/dist/dispatch.js';
import { outboxRepository } from '../apps/dispatcher/dist/outbox-repository.js';
import { generationQueue } from '../apps/dispatcher/dist/generation-queue.js';
import { generationRepository } from '../apps/worker/dist/generation-repository.js';
import { generationWorker } from '../apps/worker/dist/generation-worker.js';
import { syntheticContextResponse } from '../apps/worker/dist/generation-context.js';
import { deterministicFounderProvider, founderPrompt } from '../apps/worker/dist/founder-provider.js';
import { groqFounderProvider } from '../apps/worker/dist/groq-provider.js';
import { groqFreeQuota } from '../apps/worker/dist/groq-free-quota.js';
import { generationConsumer } from '../apps/worker/dist/generation-consumer.js';
import { createExecutionAuthorizer } from '../apps/api/dist/generation/execution-scope.js';
import { createSuppressionLedger } from '../apps/api/dist/security/suppression-ledger.js';
import { createRuntimeRecoveryClearance } from '../apps/api/dist/privacy/runtime-recovery-clearance.js';
import { startLocalGeneration } from '../scripts/p9-local-runtime.mjs';

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
  quotaUnits: 5, deadlineMs: 120_000, receiptTtlMs: 120_000 };
const meteredPolicy = { ...policy, unit: 'tokens', reservationUnits: 4608,
  quotaUnits: 9216, requestsPerMinute: 1, currentTurnBytes: 1200 };
const secret = () => randomBytes(32).toString('hex');
const browserMode = process.argv.includes('--browser');
const groqCase = process.argv.includes('--p9-groq-failure') ? 'failure'
  : process.argv.includes('--p9-groq') ? 'success' : undefined;
const p9Fault = process.argv.includes('--p9-crash') ? 'crash' :
  process.argv.includes('--p9-authority-loss') ? 'authority-loss' :
  process.argv.includes('--p9-expiry') ? 'expiry' : undefined;
const edge = process.env.WORKSPACE_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browserMessage = 'Browser founder message';
const correction = 'Correction: the pilot serves clinics.';
const correctionMessage = correction + ' ' + 'x'.repeat(1200) + 'outside the bound';
const fixtureMessages = new Set(['Synthetic USER', browserMessage, correctionMessage]);

function restrictedPool(name, credentials) {
  return new Pool({ connectionString: 'postgresql://' + roles[name] + ':' + credentials[name] +
    '@127.0.0.1:55439/' + database, statement_timeout: 5000 });
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

async function browserJourney({ account, idea, url, token, allowed, delivered, setFake, verifyUsage }) {
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
    for (const entry of ['app', 'features', 'package.json', 'tsconfig.json', 'next.config.ts', 'next-env.d.ts', 'app-mode.ts']) {
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
    let nextGeneration, first;
    const observedStreams = new Set();
    const ideaPath = '/ideas/' + idea;
    const assistantText = 'Identify the assumption that would change your decision.';
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
        const event = /^\/generations\/([a-f0-9-]{36})\/events$/.exec(path);
        if (event && method === 'GET' && !target.search && allowed.has(event[1])) {
          const controller = new AbortController();
          const closed = () => controller.abort();
          res.once('close', closed);
          try {
            const reply = await fetch(url + path, { signal: controller.signal,
              headers: { Authorization: 'Bearer ' + token, Accept: 'text/event-stream' } });
            if (reply.ok) observedStreams.add(event[1]);
            res.writeHead(reply.status, { 'Content-Type': reply.headers.get('Content-Type') ?? 'application/json' });
            if (reply.body) await pipeline(Readable.fromWeb(reply.body), res);
            else res.end();
            return;
          } finally { res.off('close', closed); }
        }
        const conversationPath = '/conversations/' + first;
        const { idea: fixtureIdea, conversation } = metadata();
        if (method === 'GET' && !target.search) {
          if (archived && path === ideaPath) return json(res, 200, fixtureIdea);
          if (archived && first && path === conversationPath) return json(res, 200, conversation);
        }
        const attempt = /^\/generations\/([a-f0-9-]{36})(\/cancel)?$/.exec(path);
        const generationRead = attempt && allowed.has(attempt[1]) && !attempt[2] && method === 'GET';
        const cancellation = attempt && allowed.has(attempt[1]) && attempt[2] === '/cancel' && method === 'POST';
        const messages = path === conversationPath + '/messages';
        const correlation = path.startsWith(conversationPath + '/submissions/') &&
          /^[a-f0-9-]{36}$/.test(path.slice((conversationPath + '/submissions/').length));
        const regeneration = path === conversationPath + '/regenerations' && method === 'POST';
        const collection = path === ideaPath + '/conversations';
        const create = collection && !first && method === 'POST';
        const workspaceRead = method === 'GET' && (path === ideaPath || collection || (first && path === conversationPath));
        if (!(workspaceRead || create || generationRead || cancellation || (messages && ['GET', 'POST'].includes(method)) ||
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
        if (create && reply.status === 201) {
          assert.equal(data.ideaId, idea);
          first = data.id;
        }
        if (collection && method === 'GET' && reply.status === 200) {
          return json(res, 200, { ...data, canCreate: reply.headers.get('X-Workspace-Conversation-Creation') === 'enabled' });
        }
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
      } catch {
        if (res.headersSent || res.destroyed) return res.destroy();
        return json(res, 503, { error: { code: 'DEPENDENCY_UNAVAILABLE' } });
      }
    });
    const port = await loopback(proxy);
    const origin = 'http://127.0.0.1:' + port;
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
    await cdp('Page.navigate', { url: origin + '/app/ideas/' + idea + '/think' });
    await text('Synthetic idea');
    await press('Create conversation');
    await browserWait(() => first && evaluate('location.pathname.endsWith(' + JSON.stringify('/conversations/' + first) + ')'), 'created conversation');
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
    assert.equal(await evaluate('document.body.innerText.includes(' + JSON.stringify(assistantText) + ')'), false);
    pauseStatus = false;
    await press('Check status');
    await text('Generation pending.');
    const accepted = nextGeneration;
    await browserWait(() => observedStreams.has(accepted), 'browser SSE connection');
    const eventUrl = url + '/generations/' + accepted + '/events';
    const eventHeaders = { Authorization: 'Bearer ' + token, Accept: 'text/event-stream' };
    const observe = () => fetch(eventUrl, { headers: eventHeaders, signal: AbortSignal.timeout(15_000) });
    const live = await observe();
    assert.equal(live.status, 200);
    assert.match(live.headers.get('content-type'), /^text\/event-stream/);
    await delivered(accepted);
    const frames = await live.text();
    assert.match(frames, /event: generation\.status[^]*"status":"PENDING"[^]*event: generation\.completed/);
    const reconnect = await observe();
    assert.match(await reconnect.text(), /^event: generation\.completed/);
    await text(assistantText);
    await verifyUsage(accepted, first);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    let release, entered;
    const running = new Promise(resolve => { entered = resolve; });
    setFake(() => new Promise(resolve => { release = resolve; entered(); }));
    await press('Regenerate');
    const replacement = await browserWait(() => nextGeneration !== accepted && nextGeneration, 'regeneration acceptance');
    void delivered(replacement).catch(error => { dispatchFailure = error; });
    await Promise.race([running, sleep(4000).then(() => { throw dispatchFailure ?? new Error('Replacement did not start'); })]);
    await text(assistantText);
    try {
      await press('Stop');
      await text('Cancellation requested.');
    } finally { release('Uncommitted replacement'); }
    await text('Generation cancelled.');
    await text(assistantText);
    assert.equal(await evaluate('document.body.innerText.includes("Uncommitted replacement")'), false);
    archived = true;
    await cdp('Page.reload');
    await text('Archived (read only)');
    await text(assistantText);
    assert.equal(await evaluate('Boolean(document.querySelector("textarea"))'), false);
    deny = true;
    await cdp('Page.reload');
    await text('This workspace item is unavailable.');
    assert.equal(await evaluate('document.body.innerText.includes(' + JSON.stringify(assistantText) + ')'), false);
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
  const adminUrl = 'postgresql://bootstrap:' + credentials.bootstrap + '@127.0.0.1:55439/' + database;
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
      if (!browserMode) {
        await admin.query((await readFile('apps/api/prisma/migrations/0002_p9_context/migration.sql')).toString());
        await admin.query((await readFile('apps/api/prisma/migrations/0003_p9_provider_receipt/migration.sql')).toString());
        await admin.query((await readFile('apps/api/prisma/migrations/0004_m06_selected_context/migration.sql')).toString());
        await admin.query((await readFile('apps/api/prisma/migrations/0005_m06_approved_memory/migration.sql')).toString());
        await admin.query(`CREATE ROLE fl_p9_context LOGIN NOINHERIT PASSWORD '${credentials.context}';
          CREATE ROLE fl_p9_context_verifier LOGIN NOINHERIT PASSWORD '${credentials.contextVerifier}';
          CREATE ROLE fl_p9_submit LOGIN NOINHERIT PASSWORD '${credentials.standaloneSubmit}';
          CREATE ROLE fl_p9_dispatch LOGIN NOINHERIT PASSWORD '${credentials.standaloneDispatch}';
          CREATE ROLE fl_p9_worker LOGIN NOINHERIT PASSWORD '${credentials.standaloneWorker}';
          CREATE ROLE fl_p9_other_context LOGIN NOINHERIT PASSWORD '${credentials.context}';
          GRANT CONNECT ON DATABASE ${database} TO fl_p9_context, fl_p9_context_verifier, fl_p9_other_context,
            fl_p9_dispatch, fl_p9_worker, fl_p9_submit`);
        await admin.query((await readFile('tests/fixtures/p9-context-grants.sql')).toString());
        await admin.query(`GRANT INSERT ("orchestrationMetadata") ON public."GenerationAttempt" TO ${roles.api};
          GRANT SELECT ("occurredAt") ON public."UsageLedger" TO ${roles.api};
          GRANT SELECT ON public."GenerationProviderReceipt" TO ${roles.fixture};
          GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO ${roles.api}`);
        await admin.query(`GRANT SELECT ("dispatchAuthorizedAt"), UPDATE ("leaseClaimant","deadlineAt")
          ON public."GenerationAttempt" TO ${roles.fixture}`);
        await admin.query(`GRANT INSERT (provenance) ON public."MemoryRevision" TO ${roles.fixture};
          GRANT INSERT (id,"ideaId","sourceMessageId","resultMemoryId",kind,candidate,status,"reviewedById","reviewedAt")
            ON public."MemoryProposal" TO ${roles.fixture};
          GRANT INSERT (id,"ideaId",origin,trust,finding,"sourceTitle","sourceLocator","retrievedAt",limitations)
            ON public."EvidenceRecord" TO ${roles.fixture};
          GRANT UPDATE (content) ON public."Message" TO ${roles.fixture};
          GRANT EXECUTE ON FUNCTION p9_context.read_with_approved_memory(uuid,integer,integer) TO fl_p9_context`);
        await admin.query(`GRANT USAGE ON SCHEMA p9_context TO fl_p9_other_context;
          GRANT EXECUTE ON FUNCTION p9_context.read_attempt(uuid,integer,integer) TO fl_p9_other_context`);
      }
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    }
    await admin.query(await readFile('tests/m05-local-generation-grants.sql', 'utf8'));
    if (browserMode) await admin.query(`
      GRANT SELECT (title,summary,version,"createdAt","updatedAt") ON "Idea" TO ${roles.api};
      GRANT SELECT (title,"metadataVersion","proactiveResearch","createdAt","updatedAt"),
        INSERT (id,"ideaId",title,status,"metadataVersion","proactiveResearch","nextSequence","createdAt","updatedAt")
        ON "Conversation" TO ${roles.api};
    `);
    if (!browserMode) await admin.query(await readFile('scripts/p9-local-runtime-grants.sql', 'utf8'));
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

/** Exercise the new function through separate authenticated PostgreSQL logins. */
async function verifyContextProjection(credentials, attempt, lease, epoch, selectedOutput, approvedMemory) {
  const connect = (user, password) => new Pool({ host: '127.0.0.1', port: 55439, database, user, password, max: 1 });
  const reader = connect('fl_p9_context', credentials.context);
  const wrong = connect('fl_p9_other_context', credentials.context);
  const issuer = connect('fl_p9_context_verifier', credentials.contextVerifier);
  const setup = connect(roles.fixture, credentials.fixture);
  const read = async (pool, id = attempt, attemptLease = lease, context = epoch) =>
    (await pool.query('SELECT p9_context.read_attempt($1,$2,$3) AS context', [id, attemptLease, context])).rows[0].context;
  try {
    assert.equal(await read(reader), null);
    await setup.query('UPDATE "GenerationAttempt" SET "leaseClaimant"=$2 WHERE id=$1', [attempt, 'fl_p9_context']);
    await issuer.query(`INSERT INTO p9_context.context_grant VALUES ($1,$2,$3,clock_timestamp()+interval '2 seconds')`,
      [attempt, lease, epoch]);
    assert.equal(await read(wrong), null);
    assert.equal(await read(reader, randomUUID()), null);
    assert.equal(await read(reader, attempt, lease + 1), null);
    assert.equal(await read(reader, attempt, lease, epoch + 1), null);
    const projection = await leasedContextReader(reader, async (id, claim, context) => {
      assert.deepEqual([id, claim, context], [attempt, lease, epoch]);
    }, Boolean(approvedMemory))({ id: attempt, contextEpoch: epoch }, { epoch: lease });
    assert.ok(projection?.current.text);
    assert.deepEqual(projection.memory.map(item => item.id), approvedMemory ? [approvedMemory] : []);
    if (approvedMemory) {
      const { rows: [stored] } = await issuer.query(`SELECT "orchestrationMetadata"->'memoryLineage' AS lineage
        FROM public."GenerationAttempt" WHERE id=$1`, [attempt]);
      assert.equal(stored.lineage.length, 1);
      assert.deepEqual(Object.keys(stored.lineage[0]).sort(), ['memoryId', 'proposalId', 'revisionId', 'sourceMessageId', 'version']);
      assert.equal(stored.lineage[0].memoryId, approvedMemory);
    }
    assert.ok(projection.previous.length <= 3);
    if (selectedOutput) assert.deepEqual(projection.previous.map(turn => turn.assistant?.id), [selectedOutput]);
    assert.equal(await read(reader), null);
    await issuer.query(`INSERT INTO p9_context.context_grant VALUES ($1,$2,$3,clock_timestamp()-interval '1 second')`,
      [attempt, lease, epoch]);
    assert.equal(await read(reader), null);
    await assert.rejects(reader.query('SELECT content FROM public."Message"'), { code: '42501' });
    await assert.rejects(reader.query('SELECT * FROM public."MemoryProposal"'), { code: '42501' });
    await assert.rejects(reader.query('UPDATE public."GenerationAttempt" SET "leaseClaimant"=session_user'), { code: '42501' });
    await assert.rejects(reader.query('DELETE FROM p9_context.context_grant'), { code: '42501' });
    await assert.rejects(reader.query('CREATE TABLE p9_context.denied (id integer)'), { code: '42501' });
    await assert.rejects(issuer.query('SELECT content FROM "Message"'), { code: '42501' });
  } finally {
    await Promise.all([reader.end(), wrong.end(), issuer.end(), setup.end()]);
  }
}

async function independentAuthority(credentials, primary, reader, admin) {
  await until(() => admin.query('SELECT 1').catch(() => false));
  const sql = await readFile('tests/fixtures/suppression-ledger-bootstrap.sql', 'utf8');
  await admin.query(sql.replace(/^\\getenv .*$/gm, '')
    .replace(":'reader_password'", "'" + credentials.authorityReader + "'")
    .replace(":'writer_password'", "'" + credentials.authorityWriter + "'"));
  const epoch = randomUUID(), integrityKey = randomBytes(32), subjectVersions = [1];
  const namespace = 'hmac-sha256-v1:' + secret();
  const seal = versions => createHmac('sha256', integrityKey)
    .update(JSON.stringify(['suppression-coverage-v2', epoch, versions, namespace])).digest('hex');
  await admin.query('GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO ledger_reader');
  await admin.query('INSERT INTO authority.coverage VALUES(true,$1,$2,$3,$4)', [epoch, seal(subjectVersions), subjectVersions, namespace]);
  const ledger = createSuppressionLedger(reader, { epoch, integrityKey, subjectVersions, challengeNamespace: namespace });
  const snapshot = await ledger.runtimeSnapshot();
  const target = await primary.query(`SELECT system_identifier::text || ':' || d.oid::text AS identity
    FROM pg_catalog.pg_control_system(), pg_catalog.pg_database d WHERE d.datname=current_database()`);
  const keys = generateKeyPairSync('ed25519'), recoveryRun = randomUUID();
  function signed(purpose, changes = {}) {
    const issuedAt = Date.now();
    const bytes = Buffer.from(JSON.stringify({ version: 1, purpose: 'founders-lens:local-generation:' + purpose,
      primaryTarget: target.rows[0].identity, authorityIdentity: snapshot.authorityIdentity, namespace,
      epoch, recoveryRun, inventoryDigest: snapshot.inventoryDigest, subjectVersions, issuedAt, expiresAt: issuedAt + 120_000,
      ...changes }));
    return JSON.stringify({ payload: bytes.toString('base64url'),
      signature: sign(null, bytes, keys.privateKey).toString('base64url') });
  }
  return { ledger, signed, async retained(versions) {
    await admin.query('UPDATE authority.coverage SET subject_versions=$1,integrity=$2', [versions, seal(versions)]);
  }, env: { FL_P6_AUTHORITY_EPOCH: epoch, FL_P6_AUTHORITY_NAMESPACE: namespace,
    FL_P6_INTEGRITY_KEY: integrityKey.toString('hex'),
    FL_P6_OPERATOR_PUBLIC_KEY: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    FL_P9_RETAINED_VERSIONS: subjectVersions.join(',') },
  decision(purpose, connection = primary, changes = {}) {
    const decision = signed(purpose, changes);
    return createRuntimeRecoveryClearance({ decision, operatorPublicKey: keys.publicKey, primary: connection,
      authority: ledger, retainedSubjectVersions: subjectVersions, purpose: 'founders-lens:local-generation:' + purpose }).verifiedDecision;
  } };
}

async function exercise({ pools, redisUrl, prefix, queue, prisma, submissionPrisma, run, credentials, trusted, startServer, startConsumer }) {
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
  let shortAdmission = false, admissionExpiry, useTrusted = false;
  const apiAuthority = { async lookup(scope, query) {
    const proof = evidence(suppressionScopeKey(scope), query);
    if (shortAdmission && proof) {
      admissionExpiry ??= proof.observedAt + 400;
      proof.validUntil = admissionExpiry;
    }
    return proof && { ...proof, integrity: 'VERIFIED', coverage: 'COMPLETE', authority: 'INDEPENDENT', epoch: run };
  } };
  const fixtureToken = 'test.' + secret() + '.fixture';
  const authenticate = async request => request.get('authorization') === 'Bearer ' + fixtureToken ? principal : null;
  const app = express();
  const groqSettings = { model: 'openai/gpt-oss-20b', priceVersion: 'v1:groq-gpt-oss-20b',
    maximumMicrosPerMillionTokens: '300000', budgetMicros: '1575', tokenBudget: '5248',
    requestsPerMinute: '1', maximumAdmissions: '1', accountId: account, conversationId: first,
    syntheticTextSha256: createHash('sha256').update('Synthetic USER').digest('hex') };
  const groqPolicy = groqCase ? localGenerationPolicy(groqSettings) : undefined;
  const admissionPolicy = groqPolicy?.policy ?? meteredPolicy;
  const trustedSubmission = trusted && createSubmissionService(createSubmissionRepository(submissionPrisma),
    trusted.ledger.authority, { clock: () => new Date(), policy: admissionPolicy, executionAdmission: trusted.decision('submit'),
      ...(groqPolicy && { allowSubmission: (actor, id, text) => groqPolicy.allows(actor.localUserId, id, text) }),
      cursorSecret: randomBytes(32) });
  const trustedAdmission = trustedSubmission && submissionRoutes(trustedSubmission, authenticate, { submitOnly: true });
  // The browser proxy can submit on behalf of the fixture. Allow only the
  // scripted message text even if someone manually opens the loopback page.
  app.post('/api/v1/conversations/:conversationId/messages', express.json({ limit: '128kb' }), (req, res, next) => {
    if (!fixtureMessages.has(req.body?.content)) {
      return res.status(400).json({ error: { code: 'FIXTURE_INPUT_DENIED' } });
    }
    next();
  });
  if (trustedAdmission) app.use('/api/v1', (req, res, next) => useTrusted ? trustedAdmission(req, res, next) : next());
  app.use('/api/v1', submissionRoutes(createSubmissionService(createSubmissionRepository(prisma), apiAuthority,
    { clock: () => new Date(), policy, cursorSecret: randomBytes(32) }), authenticate));
  app.use('/api/v1', generationRoutes(createGenerationService(createGenerationRepository(prisma, policy), apiAuthority), authenticate,
    { events: true }));
  if (browserMode) app.use('/api/v1', localConversationRoutes(localConversationOperations(prisma, apiAuthority, randomBytes(32),
    { read: async () => Date.now() + 10_000, create: async () => Date.now() + 10_000 }), authenticate));
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
  const ledger = async id => (await fixture.query('SELECT "reservationState","measuredUnits" FROM "UsageLedger" WHERE "reservationId"=$1',
    [id])).rows[0];
  const outbox = async id => {
    const { rows } = await fixture.query('SELECT id,status,"lastErrorCode" FROM "OutboxEvent" WHERE "aggregateId"=$1', [id]);
    assert.equal(rows.length, 1);
    return rows[0];
  };

  let fake, lastContext, expire = false, dispatchDenied = false, executions = 0;
  const allowed = new Set(), work = generationRepository(pools.worker, { singleInvocation: true });
  const founderProvider = deterministicFounderProvider();
  const worker = generationWorker(work, async (scope, query) => {
    const proof = evidence(scope, query);
    return expire && proof ? { ...proof, validUntil: proof.observedAt } : proof;
  }, id => allowed.has(id), undefined, Date.now, async (context, signal) => {
    executions++;
    lastContext = context;
    if (executions === 1) return (await founderProvider.generate(founderPrompt(context), signal)).text;
    return fake ? fake() : syntheticContextResponse(context);
  });
  const consumer = generationConsumer(redisUrl, prefix, worker, Number(redisUrl.port));
  startConsumer(consumer);
  await consumer.waitUntilReady();

  async function poll(id) {
    const { id: eventId } = await outbox(id);
    allowed.add(id);
    const repository = outboxRepository(pools.dispatch, [eventId]);
    const pump = dispatcher(repository, generationQueue(redisUrl, prefix, undefined, Number(redisUrl.port)),
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
    return browserJourney({ account, idea, url, token: fixtureToken, allowed, delivered,
      setFake: next => { fake = next; },
      async verifyUsage(id, conversationId) {
        const completed = await status(id);
        assert.ok(completed.selected && completed.outputMessageId);
        assert.deepEqual(await ledger(id), { reservationState: 'SETTLED', measuredUnits: '1.00000' });
        assert.equal((await fixture.query('SELECT id FROM "Message" WHERE "conversationId"=$1', [conversationId])).rowCount, 2);
      } });
  }

  const key = randomUUID(), body = { clientSubmissionId: randomUUID(), content: 'Synthetic USER' };
  assert.equal((await submit(first, 400, randomUUID(),
    { clientSubmissionId: randomUUID(), content: 'Unscripted test sentinel' })).error.code, 'FIXTURE_INPUT_DENIED');
  assert.deepEqual((await history(first)).items, []);
  // Hold the real account lock until the admitted evidence expires.
  const blocker = await pools.api.connect();
  let expiredSubmission;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM "UserAccount" WHERE id=$1 FOR UPDATE', [account]);
    shortAdmission = true;
    expiredSubmission = submit(first, 503);
    void expiredSubmission.catch(() => {});
    await until(async () => (await pools.api.query(`SELECT EXISTS (SELECT FROM pg_stat_activity
      WHERE usename=current_user AND cardinality(pg_blocking_pids(pid))>0) AS waiting`)).rows[0].waiting);
    await sleep(Math.max(0, admissionExpiry - Date.now()) + 20);
    await blocker.query('COMMIT');
    assert.equal((await expiredSubmission).error.code, 'DEPENDENCY_UNAVAILABLE');
  } finally {
    shortAdmission = false;
    try { await blocker.query('ROLLBACK'); } finally { blocker.release(); }
  }
  assert.deepEqual((await history(first)).items, []);
  useTrusted = Boolean(trusted);
  const admitted = await submit(first, 202, key, body);
  const id = admitted.generationId;
  assert.deepEqual(await submit(first, 202, key, body), admitted);
  if (trusted) {
    if (groqCase) {
      assert.equal((await submit(second, 404)).error.code, 'RESOURCE_NOT_FOUND');
      assert.equal((await submit(first, 409)).error.code, 'GENERATION_IN_PROGRESS');
    } else {
      assert.equal((await submit(second, 429)).error.code, 'QUOTA_EXCEEDED');
      await submit(second, 413, randomUUID(), { clientSubmissionId: randomUUID(), content: correctionMessage });
    }
    assert.deepEqual(await trustedSubmission.correlate(principal, first, body.clientSubmissionId), {
      messageId: admitted.messageId, generationId: id
    });
    assert.deepEqual((await trustedSubmission.history(principal, first, {})).items.map(item => item.role), ['USER']);
    const trustedStatus = createGenerationService(createGenerationRepository(submissionPrisma, admissionPolicy),
      trusted.ledger.authority, async () => (await trusted.decision('status')()).expiresAt);
    assert.equal((await trustedStatus.status(principal, id)).status, 'PENDING');
  }
  useTrusted = false;
  assert.equal((await status(id)).status, 'PENDING');
  assert.equal((await outbox(id)).status, 'PENDING');
  assert.equal((await ledger(id)).reservationState, 'RESERVED');
  assert.equal((await fixture.query('SELECT id FROM "IdempotencyRecord" WHERE "accountId"=$1', [account])).rowCount, 1);
  assert.equal((await fixture.query('SELECT id FROM "Message" WHERE "conversationId"=$1', [first])).rowCount, 1);
  if (trusted) {
    const authorize = decision => createExecutionAuthorizer(pools.contextVerifier, trusted.ledger.authority, decision, 'dispatch')(id);
    const timestamp = Date.now();
    for (const changes of [{ primaryTarget: '1:1' }, { authorityIdentity: '2:2' }, { subjectVersions: [1, 2] },
      { issuedAt: timestamp - 2000, expiresAt: timestamp - 1000 }]) {
      await assert.rejects(authorize(trusted.decision('dispatch', pools.contextVerifier, changes)));
    }
    const env = { ...trusted.env, FL_P9_LOCAL_RUNTIME: 'deterministic', FL_P9_DISPOSABLE: '1', FL_P9_MAX_ADMISSIONS: '1',
      P9_GEMINI_MODEL: 'gemini-3.1-flash-lite', FL_P9_SYNTHETIC_ACCOUNT: account, FL_P9_SYNTHETIC_CONVERSATION: first,
      FL_P9_SYNTHETIC_TEXT_SHA256: createHash('sha256').update(body.content).digest('hex'),
      FL_P9_DISPATCH_DECISION: trusted.signed('dispatch'), FL_P9_EXECUTE_DECISION: trusted.signed('execute'),
      FL_P9_REDIS_RUN: run, FL_P9_REDIS_URL: redisUrl.href,
      FL_P9_DISPATCH_DATABASE_URL: `postgresql://fl_p9_dispatch:${credentials.standaloneDispatch}@127.0.0.1:55439/${database}`,
      FL_P9_WORKER_DATABASE_URL: `postgresql://fl_p9_worker:${credentials.standaloneWorker}@127.0.0.1:55439/${database}`,
      FL_P9_VERIFIER_DATABASE_URL: `postgresql://fl_p9_context_verifier:${credentials.contextVerifier}@127.0.0.1:55439/${database}`,
      FL_P9_AUTHORITY_DATABASE_URL: `postgresql://ledger_reader:${credentials.authorityReader}@127.0.0.1:55440/suppression_proof`
    };
    if (groqCase) Object.assign(env, { FL_P9_PROVIDER: 'groq', P9_GROQ_MODEL: groqSettings.model,
      FL_P9_PRICE_VERSION: groqSettings.priceVersion, FL_P9_MAX_MICROS_PER_MILLION_TOKENS: groqSettings.maximumMicrosPerMillionTokens,
      FL_P9_BUDGET_MICROS: groqSettings.budgetMicros, FL_P9_ACCOUNT_TOKEN_BUDGET: groqSettings.tokenBudget,
      FL_P9_REQUESTS_PER_MINUTE: '1' });
    await assert.rejects(startLocalGeneration({ ...env, NODE_ENV: 'production' }));
    await assert.rejects(startLocalGeneration({ ...env, FL_P9_LOCAL_RUNTIME: 'gemini',
      FL_P9_GEMINI_CONFIRM: 'approve-one-synthetic-invocation' }));
    await assert.rejects(startLocalGeneration({ ...env, FL_P9_SYNTHETIC_CONVERSATION: randomUUID() }));
    await assert.rejects(startLocalGeneration({ ...env, FL_P9_DISPATCH_DECISION: undefined }));
    await assert.rejects(startLocalGeneration({ ...env, FL_P9_EXECUTE_DECISION: trusted.signed('execute',
      { issuedAt: timestamp - 2000, expiresAt: timestamp - 1000 }) }));
    await trusted.retained([1, 2]);
    try {
      await assert.rejects(startLocalGeneration(env));
      assert.equal((await outbox(id)).status, 'PENDING');
    } finally { await trusted.retained([1]); }
    await pools.authorityAdmin.query('REVOKE SELECT ON authority.coverage FROM ledger_reader');
    try {
      await assert.rejects(startLocalGeneration(env));
      assert.equal((await outbox(id)).status, 'PENDING');
      assert.equal(executions, 0);
    } finally {
      await pools.authorityAdmin.query('GRANT SELECT ON authority.coverage TO ledger_reader');
    }
    const broker = new Redis(redisUrl.href, { maxRetriesPerRequest: 0 });
    const standalone = new Queue('generation', { prefix: 'founders-lens-p9-local-' + run, connection: createIORedisClient(broker) });
    const restrictedWorker = new Pool({ connectionString: env.FL_P9_WORKER_DATABASE_URL });
    let runtime;
    const report = event => { if (event === 'P9_DETERMINISTIC_INVOCATION') executions++; };
    try {
      await assert.rejects(restrictedWorker.query('SELECT content FROM public."Message"'), { code: '42501' });
      await assert.rejects(restrictedWorker.query('SELECT * FROM public."ConfirmedMemory"'), { code: '42501' });
      await assert.rejects(restrictedWorker.query('DELETE FROM public."GenerationProviderReceipt"'), { code: '42501' });
      await assert.rejects(restrictedWorker.query('INSERT INTO p9_context.context_grant DEFAULT VALUES'), { code: '42501' });
      if (groqCase) {
        const events = [];
        const mockedGroq = groqFounderProvider('gsk_' + 'offline_synthetic_fixture', async () => {
          executions++;
          return groqCase === 'failure' ? Response.json({ error: { message: 'Fixture rejection' } }, { status: 503 })
            : Response.json({ id: 'chatcmpl-offline-groq', choices: [
              { finish_reason: 'stop', message: { role: 'assistant', content: 'Offline Groq answer' } }
            ], usage: { prompt_tokens: 85, completion_tokens: 130, total_tokens: 215 } });
        }, event => events.push(event));
        runtime = await startLocalGeneration(env, report, { deterministicProvider: mockedGroq });
        const completed = groqCase === 'success';
        const result = await terminal(id, completed ? 'COMPLETED' : 'FAILED');
        if (!completed) assert.deepEqual(result.error, { code: 'PROVIDER_OUTCOME_UNKNOWN', retryable: false });
        const job = await standalone.getJob(id);
        await until(async () => (await job.getState()) === 'completed');
        await job.retry('completed');
        await until(async () => (await job.getState()) === 'completed');
        assert.equal(executions, 1);
        assert.deepEqual(events, completed ? [] : ['GROQ_PROVIDER_UNAVAILABLE']);
        assert.deepEqual(await ledger(id), completed ? { reservationState: 'SETTLED', measuredUnits: '215.00000' }
          : { reservationState: 'RESERVED', measuredUnits: '0.00000' });
        const { rows } = await fixture.query(`SELECT "inputTokens","outputTokens","totalTokens"
          FROM public."GenerationProviderReceipt" WHERE "attemptId"=$1`, [id]);
        assert.deepEqual(rows, completed ? [{ inputTokens: 85, outputTokens: 130, totalTokens: 215 }] : []);
        assert.deepEqual((await history(first)).items.map(item => item.content),
          completed ? [body.content, 'Offline Groq answer'] : [body.content]);
        useTrusted = true;
        assert.equal((await submit(first, 429)).error.code, 'QUOTA_EXCEEDED');
        return;
      }
      const expireAttempt = () => fixture.query(`UPDATE "GenerationAttempt"
        SET "deadlineAt"=clock_timestamp()-interval '1 second' WHERE id=$1`, [id]);
      if (p9Fault === 'expiry') {
        await expireAttempt();
        runtime = await startLocalGeneration(env, report);
        await terminal(id, 'FAILED');
        assert.deepEqual(await ledger(id), { reservationState: 'RELEASED', measuredUnits: '0.00000' });
        assert.equal(await standalone.getJob(id), undefined);
      } else if (p9Fault === 'authority-loss') {
        const observation = { text: 'Unpublished synthetic answer', responseId: 'offline-authority-loss',
          usage: { inputTokens: 17, outputTokens: 9, totalTokens: 26 } };
        runtime = await startLocalGeneration(env, report, {
          deterministicProvider: { async generate() { executions++; return observation; } },
          afterOfflineObservation: () => pools.authorityAdmin.query('REVOKE SELECT ON authority.coverage FROM ledger_reader')
        });
        try {
          await until(async () => (await ledger(id)).reservationState === 'SETTLED');
          const job = await standalone.getJob(id);
          // Do not restore authority until the worker attempted finalization and returned.
          await until(async () => (await job.getState()) === 'completed');
          assert.deepEqual((await history(first)).items.map(item => item.role), ['USER']);
          await expireAttempt();
        } finally {
          await pools.authorityAdmin.query('GRANT SELECT ON authority.coverage TO ledger_reader');
        }
        await terminal(id, 'FAILED');
        assert.deepEqual(await ledger(id), { reservationState: 'SETTLED', measuredUnits: '26.00000' });
        assert.equal((await fixture.query(`SELECT "responseId" FROM public."GenerationProviderReceipt"
          WHERE "attemptId"=$1`, [id])).rows[0].responseId, observation.responseId);
      } else if (p9Fault === 'crash') {
        const child = spawn(process.execPath, ['--input-type=module', '-e', `
          import { startLocalGeneration } from './scripts/p9-local-runtime.mjs';
          const runtime = await startLocalGeneration(process.env, () => {}, { deterministicProvider: {
            async generate() {
              console.log('OFFLINE_PROVIDER_ENTERED');
              return new Promise(() => {});
            }
          } });
          await runtime.finished;
        `], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'] });
        const exited = once(child, 'exit');
        let entered = false, output = '';
        child.stdout.setEncoding('utf8').on('data', chunk => {
          output = (output + chunk).slice(-128);
          entered ||= output.includes('OFFLINE_PROVIDER_ENTERED');
        });
        try {
          await until(() => entered);
          executions++;
          assert.ok((await fixture.query(`SELECT "dispatchAuthorizedAt" FROM public."GenerationAttempt"
            WHERE id=$1`, [id])).rows[0].dispatchAuthorizedAt);
        } finally {
          child.kill('SIGKILL');
          await exited;
        }
        await expireAttempt();
        runtime = await startLocalGeneration(env, report);
        const failed = await terminal(id, 'FAILED');
        assert.deepEqual(failed.error, { code: 'PROVIDER_OUTCOME_UNKNOWN', retryable: false });
        assert.deepEqual(await ledger(id), { reservationState: 'RESERVED', measuredUnits: '0.00000' });
        assert.equal((await fixture.query(`SELECT "responseId" FROM public."GenerationProviderReceipt"
          WHERE "attemptId"=$1`, [id])).rowCount, 0);
      }
      if (p9Fault) {
        const correlated = await request(convo(first) + '/submissions/' + body.clientSubmissionId, 200);
        assert.equal(correlated.generationId, id);
        assert.equal(correlated.messageId, admitted.messageId);
        assert.deepEqual((await history(first)).items.map(item => item.role), ['USER']);
        assert.equal(executions, p9Fault === 'expiry' ? 0 : 1);
        return;
      }
      // Simulate a published outbox event that Redis lost before any claim.
      await pools.dispatch.query(`UPDATE "OutboxEvent" SET status='PUBLISHED',"publishedAt"=clock_timestamp()
        WHERE id=$1`, [(await outbox(id)).id]);
      assert.equal(await standalone.getJob(id), undefined);
      runtime = await startLocalGeneration(env, report);
      assert.equal((await terminal(id, 'COMPLETED')).selected, true);
      assert.equal((await outbox(id)).status, 'PUBLISHED');
      const job = await standalone.getJob(id);
      assert.deepEqual(job.data, { generationId: id });
      await until(async () => (await job.getState()) === 'completed');
      await runtime.close();
      // Restart the same isolated namespace, then redeliver the completed job.
      runtime = await startLocalGeneration(env, report);
      await job.retry('completed');
      await until(async () => (await job.getState()) === 'completed');
    } finally {
      await runtime?.close();
      await restrictedWorker.end();
      await standalone.close();
      broker.disconnect();
    }
  } else {
    const job = await delivered(id);
    assert.equal((await terminal(id, 'COMPLETED')).selected, true);
    await until(async () => (await job.getState()) === 'completed');
    await poll(id);
    await worker.process(job);
  }
  assert.equal(executions, 1);
  assert.equal((await cancel(id, 200)).status, 'COMPLETED');
  assert.deepEqual(await ledger(id), { reservationState: 'SETTLED', measuredUnits: trusted ? '26.00000' : '1.00000' });
  if (trusted) {
    const { rows } = await fixture.query(`SELECT "responseId","inputTokens","outputTokens","totalTokens"
      FROM public."GenerationProviderReceipt" WHERE "attemptId"=$1`, [id]);
    assert.deepEqual(rows, [{ responseId: 'p9-deterministic-observation', inputTokens: 17, outputTokens: 9, totalTokens: 26 }]);
    await assert.rejects(pools.worker.query('DELETE FROM public."GenerationProviderReceipt"'), { code: '42501' });
  }
  const initialTranscript = (await history(first)).items;
  assert.deepEqual(initialTranscript.map(item => item.role), ['USER', 'ASSISTANT']);
  assert.equal(initialTranscript[0].content, body.content);
  assert.match(initialTranscript[1].content, /Identify the assumption.*pass threshold/);
  if (trusted) {
    const structured = await request(convo(first) + '/messages?assistantResponseVersion=2', 200);
    assert.deepEqual(structured.items[0], initialTranscript[0]);
    assert.equal(initialTranscript[1].assistantContent, undefined);
    assert.deepEqual(structured.items[1], { ...initialTranscript[1], assistantContent: {
      schemaVersion: 1, primaryStrategy: 'CHALLENGE', nextQuestion: 'What result would disprove this assumption?',
      citationRefs: [], proposalIds: [], actions: []
    } });
    const claimText = 'The fixture recorded three trials.', qualification = 'Synthetic sample only.';
    const unrelatedIdea = randomUUID();
    await fixture.query('INSERT INTO "Idea" (id,"ownerId",title,"updatedAt") VALUES ($1,$2,$3,now())',
      [unrelatedIdea, account, 'Separate citation fixture']);
    const seedEvidence = async (ideaId, trust) => {
      const id = randomUUID();
      await fixture.query(`INSERT INTO "EvidenceRecord"
      (id,"ideaId",origin,trust,finding,"sourceTitle","sourceLocator","retrievedAt",limitations)
      VALUES ($1,$2,'EXTERNAL_SOURCE',$3,$4,'Fixture source','https://example.invalid/evidence',now(),$5)`,
      [id, ideaId, trust, claimText, qualification]);
      return id;
    };
    const evidenceId = await seedEvidence(idea, 'SOURCE_CHECKED');
    const unrelatedEvidence = await seedEvidence(unrelatedIdea, 'SOURCE_CHECKED');
    const staleEvidence = await seedEvidence(idea, 'STALE');
    const reply = structured.items[1];
    const original = { text: reply.content, assistantContent: reply.assistantContent };
    const setCitation = citationRefs => fixture.query('UPDATE "Message" SET content=$2 WHERE id=$1',
      [reply.id, { ...original, assistantContent: { ...reply.assistantContent, citationRefs } }]);
    const citedHistory = createSubmissionService(createSubmissionRepository(submissionPrisma, true),
      trusted.ledger.authority, { clock: () => new Date(), cursorSecret: randomBytes(32) });
    const citation = { evidenceId, claimText, qualification };
    try {
      await setCitation([citation]);
      const accepted = await citedHistory.history(principal, first, { assistantResponseVersion: '2' });
      assert.deepEqual(accepted.items.at(-1).assistantContent.citationRefs, [citation]);
      for (const unsupported of [{ ...citation, claimText: 'The fixture proved market demand.' },
        { ...citation, evidenceId: unrelatedEvidence }, { ...citation, evidenceId: staleEvidence },
        { ...citation, qualification: undefined }]) {
        await setCitation([unsupported]);
        await assert.rejects(citedHistory.history(principal, first, { assistantResponseVersion: '2' }),
          error => error.failure('fixture').body.error.code === 'PROJECTION_UNAVAILABLE');
      }
    } finally {
      await fixture.query('UPDATE "Message" SET content=$2 WHERE id=$1', [reply.id, original]);
    }
  }

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

  async function seedMemory(ideaId, message, state = 'ACTIVE', actor = account, sourceMessage) {
    const memory = randomUUID(), content = { text: message };
    const proposal = sourceMessage ? randomUUID() : undefined;
    await fixture.query(`INSERT INTO "ConfirmedMemory" (id,"ideaId",kind,"currentContent",status,"updatedAt")
      VALUES ($1,$2,'FACT',$3,$4,now())`, [memory, ideaId, content, state]);
    if (proposal) await fixture.query(`INSERT INTO "MemoryProposal"
      (id,"ideaId","sourceMessageId","resultMemoryId",kind,candidate,status,"reviewedById","reviewedAt")
      VALUES ($1,$2,$3,$4,'FACT',$5,'ACCEPTED',$6,now())`, [proposal, ideaId, sourceMessage, memory, content, actor]);
    await fixture.query(`INSERT INTO "MemoryRevision" (id,"memoryId",version,content,"actorId",provenance)
      VALUES ($1,$2,1,$3,$4,$5)`, [randomUUID(), memory, content, actor, proposal ? { proposalId: proposal } : {}]);
    return memory;
  }
  const otherIdea = randomUUID();
  await fixture.query('INSERT INTO "Idea" (id,"ownerId",title,"updatedAt") VALUES ($1,$2,$3,now())',
    [otherIdea, account, 'Other synthetic idea']);
  const reviewed = await seedMemory(idea, 'Reviewed channel is referrals', 'ACTIVE', account, admitted.messageId);
  await seedMemory(otherIdea, 'Other idea confidential marker');
  const foreign = randomUUID(), foreignIdea = randomUUID();
  await fixture.query('INSERT INTO "UserAccount" (id,"clerkSubject","clerkInstanceId","subjectKey","updatedAt") VALUES ($1,$2,$3,$4,now())',
    [foreign, 'fixture-' + foreign, instance, createHash('sha256').update(foreign).digest('hex')]);
  await fixture.query('INSERT INTO "Idea" (id,"ownerId",title,"updatedAt") VALUES ($1,$2,$3,now())',
    [foreignIdea, foreign, 'Foreign synthetic idea']);
  await seedMemory(foreignIdea, 'Foreign account confidential marker', 'ACTIVE', foreign);
  await fixture.query(`INSERT INTO "MemoryProposal" (id,"ideaId",kind,candidate)
    VALUES ($1,$2,'FACT',$3)`, [randomUUID(), idea, { text: 'Pending confidential marker' }]);
  let contextReady, finishFollowUp;
  const followUpContext = new Promise(resolve => { contextReady = resolve; });
  const followUpGate = new Promise(resolve => { finishFollowUp = resolve; });
  fake = async () => {
    contextReady();
    await followUpGate;
    return syntheticContextResponse(lastContext);
  };
  const followUp = await submit(first, 202, randomUUID(),
    { clientSubmissionId: randomUUID(), content: correctionMessage });
  await delivered(followUp.generationId);
  try {
    await Promise.race([followUpContext, sleep(4000).then(() => { throw new Error('Follow-up did not enter the worker'); })]);
    const active = await work.scope(followUp.generationId);
    const { rows: [{ leaseEpoch }] } = await fixture.query('SELECT "leaseEpoch" FROM "GenerationAttempt" WHERE id=$1', [active.id]);
    await verifyContextProjection(credentials, active.id, leaseEpoch, active.contextEpoch, replacement.outputMessageId, reviewed);
  } finally {
    finishFollowUp();
    fake = undefined;
  }
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
    if (!browserMode) await verifyContextProjection(credentials, during, leaseEpoch, active.contextEpoch);
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
  let uncertainInvocations = 0;
  fake = async () => {
    uncertainInvocations++;
    expire = true;
    throw new Error('Synthetic uncertain invocation');
  };
  const unknownJob = await delivered(unknown);
  await until(async () => (await unknownJob.getState()) === 'completed');
  expire = false;
  await expireLease(unknown);
  await worker.recover([unknown]);
  await worker.recover([unknown]);
  const uncertain = await status(unknown);
  assert.equal(uncertain.status, 'FAILED');
  assert.deepEqual(uncertain.error, { code: 'PROVIDER_OUTCOME_UNKNOWN', retryable: false });
  assert.equal(uncertainInvocations, 1);
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
  const credentials = Object.fromEntries([...Object.keys(roles), 'bootstrap', 'redis', 'context', 'contextVerifier',
    'authorityAdmin', 'authorityReader', 'authorityWriter', 'standaloneSubmit', 'standaloneDispatch',
    'standaloneWorker'].map(name => [name, secret()]));
  const redisUrl = new URL('redis://:' + credentials.redis + '@127.0.0.1:56382/0');
  const pools = {}, containers = [];
  let networkId, redis, queue, consumer, prisma, submissionPrisma, server;
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
    const pgId = start('pg', pgImage, '55439', '5432', '/var/lib/postgresql/data:rw,nosuid,nodev,mode=0700',
      ['-e', 'POSTGRES_USER=bootstrap', '-e', 'POSTGRES_DB=' + database, '-e', 'POSTGRES_PASSWORD_FILE=/tmp/bootstrap',
        '--entrypoint', 'sh'], ['-ec', 'while [ ! -s /tmp/bootstrap ]; do sleep 1; done; exec docker-entrypoint.sh postgres']);
    docker(['exec', '-i', pgId, 'sh', '-ec', 'umask 077; cat > /tmp/bootstrap-new; mv /tmp/bootstrap-new /tmp/bootstrap'],
      credentials.bootstrap);
    await postgres(pgId, run, credentials);
    const redisId = start('redis', redisImage, '56382', '6379', '/data:rw,noexec,nosuid,nodev,mode=1777',
      ['--entrypoint', 'sh'], ['-ec', 'while [ ! -s /tmp/run-config ]; do sleep 1; done; exec redis-server /tmp/run-config']);
    docker(['exec', '-i', redisId, 'sh', '-ec', 'umask 077; cat > /tmp/run-config-new; mv /tmp/run-config-new /tmp/run-config'],
      'bind 0.0.0.0\nprotected-mode yes\nrequirepass ' + credentials.redis + '\nsave ""\nappendonly no\n');
    for (const name of Object.keys(roles)) {
      pools[name] = restrictedPool(name, credentials);
      await verify(pools[name], name, run);
    }
    let trusted;
    if (!browserMode) {
      const authorityId = start('authority', pgImage, '55440', '5432', '/var/lib/postgresql/data:rw,nosuid,nodev,mode=0700',
        ['-e', 'POSTGRES_DB=suppression_proof', '-e', 'POSTGRES_PASSWORD_FILE=/tmp/bootstrap',
          '--entrypoint', 'sh'], ['-ec', 'while [ ! -s /tmp/bootstrap ]; do sleep 1; done; exec docker-entrypoint.sh postgres']);
      docker(['exec', '-i', authorityId, 'sh', '-ec', 'umask 077; cat > /tmp/bootstrap-new; mv /tmp/bootstrap-new /tmp/bootstrap'],
        credentials.authorityAdmin);
      const connect = (port, database, user, password) => new Pool({ host: '127.0.0.1', port, database, user, password,
        connectionTimeoutMillis: 1000, statement_timeout: 3000 });
      pools.contextVerifier = connect(55439, database, 'fl_p9_context_verifier', credentials.contextVerifier);
      pools.authorityAdmin = connect(55440, 'suppression_proof', 'postgres', credentials.authorityAdmin);
      pools.authorityReader = connect(55440, 'suppression_proof', 'ledger_reader', credentials.authorityReader);
      trusted = await independentAuthority(credentials, pools.contextVerifier, pools.authorityReader, pools.authorityAdmin);
    }
    redis = new Redis(redisUrl.href, { maxRetriesPerRequest: 0, connectTimeout: 1000 });
    redis.on('error', () => {});
    await until(() => redis.ping().catch(() => false));
    assert.equal((await redis.info('keyspace')).trim(), '# Keyspace');
    assert.equal((await redis.client('LIST')).trim().split('\n').length, 1);
    const quotaClient = new Redis(redisUrl.href, { maxRetriesPerRequest: 0, connectTimeout: 1000 });
    try {
      const organization = randomBytes(32).toString('hex');
      const policy = { inputTokens: 1800, completionTokens: 1200,
        limits: { rpm: 10, rpd: 40, tpm: 3000, tpd: 3000 } };
      const attempts = await Promise.allSettled([redis, quotaClient].map(client => groqFreeQuota(client, organization, policy).reserve()));
      const accepted = attempts.filter(attempt => attempt.status === 'fulfilled');
      assert.equal(accepted.length, 1);
      await accepted[0].value(); // Unknown usage keeps the full reservation.
      quotaClient.disconnect();
      await quotaClient.connect();
      // Simulate lease expiry without advancing the usage window.
      await redis.del(`founders-lens:groq-free:{${organization}}:active`);
      await assert.rejects(groqFreeQuota(quotaClient, organization, policy).reserve(), /quota is currently unavailable/);
    } finally { quotaClient.disconnect(); }
    const liveBroker = (await redis.info('server')).match(/^run_id:(\w+)/m)?.[1];
    assert.ok(liveBroker);
    queue = new Queue('generation', { prefix, connection: createIORedisClient(redis) });
    const apiUrl = 'postgresql://' + roles.api + ':' + credentials.api + '@127.0.0.1:55439/' + database;
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: apiUrl, statement_timeout: 5000 }) });
    if (trusted) submissionPrisma = new PrismaClient({ adapter: new PrismaPg({
      connectionString: `postgresql://fl_p9_submit:${credentials.standaloneSubmit}@127.0.0.1:55439/${database}`
    }) });
    await exercise({ pools, redisUrl, prefix, queue, prisma, submissionPrisma, run, credentials, trusted, startServer: value => { server = value; },
      startConsumer: value => { consumer = value; } });
    assert.equal((await redis.info('server')).match(/^run_id:(\w+)/m)?.[1], liveBroker);
  } finally {
    try {
      if (server) await new Promise(resolve => server.close(resolve));
      await consumer?.close();
      await queue?.close();
      redis?.disconnect();
      await prisma?.$disconnect();
      await submissionPrisma?.$disconnect();
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
