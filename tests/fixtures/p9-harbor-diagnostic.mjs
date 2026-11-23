// Owner-assisted HTTP probe. The write boundary is absent and both Prisma pools are read-only.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { createRequire } from 'node:module';
import express from 'express';
import pg from 'pg';
import { createApp } from '../../apps/api/dist/app.js';
import { PrismaClient } from '../../apps/api/dist/generated/prisma/client.js';
import { localGenerationPolicy } from '../../apps/api/dist/generation/local-policy.js';
import { SecurityError } from '../../apps/api/dist/security/errors.js';
import { PrismaIdentityRepository } from '../../apps/api/dist/security/identity-repository.js';
import { IdentityService } from '../../apps/api/dist/security/identity-service.js';
import { requestContext } from '../../apps/api/dist/security/request-context.js';
import { createSubmissionRepository } from '../../apps/api/dist/submission/repository.js';
import { submissionRoutes } from '../../apps/api/dist/submission/routes.js';
import { createSubmissionService } from '../../apps/api/dist/submission/service.js';
import { workspaceIdeasCors } from '../../apps/api/dist/workspace/read-only-composition.js';
import { harborCartHash, harborCartPrompt, readFirstExperiment, readSecondScope } from './p9-second-binding.mjs';

/** Exercise genuine Clerk, route and scope checks without a signed generation grant or database write. */
export async function diagnoseHarbor({ context, config, boundary, provider, evaluate, origin, verifiedSubject }) {
  assert.ok(context.isolated, 'Isolated P9 target required');
  const { primaryTarget } = await context.verify();
  const env = async file => parseEnv(await readFile(file, 'utf8'));
  const scope = await env('.env.p9-second-scope.local');
  const first = await env('.env.p9-scope.local');
  const credentials = await env('.env.p9-api.local');
  assert.equal(scope.FL_P9_SYNTHETIC_TEXT_SHA256, harborCartHash);
  assert.equal(createHash('sha256').update(harborCartPrompt, 'utf8').digest('hex'), harborCartHash);
  const accountId = scope.FL_P9_SYNTHETIC_ACCOUNT, conversationId = scope.FL_P9_SYNTHETIC_CONVERSATION;
  const identity = { instanceId: config.instanceId, subject: verifiedSubject };
  const digest = context.subjectKeys.derive(identity.instanceId, identity.subject)[0];
  const before = await readFirstExperiment(context.primary, first, identity);
  const binding = await readSecondScope(context.primary, identity, digest);
  assert.ok(binding?.account === accountId && binding.conversation === conversationId, 'Harbor Cart binding mismatch');
  const { PrismaPg } = createRequire(new URL('../../apps/api/package.json', import.meta.url))('@prisma/adapter-pg');
  const pools = [], clients = [];
  const prisma = async (user, password) => {
    const pool = new pg.Pool({ host: '127.0.0.1', port: 55435, database: 'founders_lens_p9_local', user, password,
      max: 1, options: '-c default_transaction_read_only=on', statement_timeout: 4000, connectionTimeoutMillis: 1500 });
    pools.push(pool);
    const { rows: [state] } = await pool.query(`SELECT system_identifier::text || ':' || oid::text AS target,
      current_setting('transaction_read_only') AS readonly
      FROM pg_catalog.pg_control_system(), pg_catalog.pg_database WHERE datname=current_database()`);
    assert.ok(state.target === primaryTarget && state.readonly === 'on', 'Incorrect diagnostic database target');
    const client = new PrismaClient({ adapter: new PrismaPg(pool), log: [], errorFormat: 'minimal' });
    clients.push(client);
    return client;
  };
  let server;
  try {
    const accounts = new PrismaIdentityRepository(await prisma('fl_p6_workspace', credentials.FL_P6_WORKSPACE_PASSWORD));
    const resolver = new IdentityService(config.instanceId, context.subjectKeys, provider,
      { resolve: accounts.resolveExisting.bind(accounts) }, context.ledger.authority);
    const repo = createSubmissionRepository(await prisma('fl_p9_submit', credentials.FL_P9_SUBMIT_PASSWORD));
    const policy = localGenerationPolicy({ model: 'gemini-3.1-flash-lite', priceVersion: 'v1:harbor-diagnostic',
      maximumMicrosPerMillionTokens: '1500000', budgetMicros: '6912', tokenBudget: '4608',
      requestsPerMinute: '1', maximumAdmissions: '1', accountId, conversationId, syntheticTextSha256: harborCartHash });
    let reachedWriteBoundary = false, ownedScopeRead = false;
    const service = createSubmissionService({
      scope: repo.scope,
      async accept() {
        reachedWriteBoundary = true;
        throw new SecurityError('DEPENDENCY_UNAVAILABLE', 'SUBMISSION_CAPABILITY_DENIED');
      }
    }, context.ledger.authority, { clock: () => new Date(), policy: policy.policy,
      allowSubmission: (principal, id, text) => policy.allows(principal.localUserId, id, text) });
    const router = express.Router();
    router.use(workspaceIdeasCors(false, { create: false, save: false }, conversationId));
    router.use(submissionRoutes(service, async request => {
      const verified = await boundary.authenticate(request.headers, request.rawHeaders);
      if (verified.subject !== verifiedSubject) throw new SecurityError('UNAUTHENTICATED');
      const principal = await resolver.resolve(verified, requestContext(request.res).requestId);
      const owned = await repo.scope(principal, conversationId);
      ownedScopeRead = principal.localUserId === accountId && owned?.id === conversationId;
      assert.ok(ownedScopeRead, 'Harbor Cart ownership check failed');
      assert.ok(!await repo.scope(principal, first.FL_P9_SYNTHETIC_CONVERSATION), 'Foreign scope was readable');
      return principal;
    }, { submitOnly: true }));
    server = createApp(router).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { rows: [route] } = await context.primary.query(
      'SELECT "ideaId" FROM public."Conversation" WHERE id=$1', [conversationId]);
    const path = '/app/ideas/' + route.ideaId + '/conversations/' + conversationId;
    await evaluate(`location.assign(${JSON.stringify(origin + path)}); true`);
    const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/v1/conversations/' + conversationId + '/messages';
    for (let i = 0; i < 60; i++) {
      if (await evaluate(`location.pathname === ${JSON.stringify(path)} && window.Clerk?.session?.status === 'active'`)) break;
      await new Promise(resolve => setTimeout(resolve, 500));
      if (i === 59) throw new Error('Harbor Cart browser route did not become authenticated');
    }
    const probe = async content => evaluate(`(async () => {
      const token = await window.Clerk.session.getToken({skipCache:true});
      const response = await fetch(${JSON.stringify(endpoint)}, { method:'POST', credentials:'omit', redirect:'error',
        headers: { Authorization:'Bearer '+token, 'Content-Type':'application/json', 'Idempotency-Key':${JSON.stringify(randomUUID())} },
        body: JSON.stringify({content:${JSON.stringify(content)},clientSubmissionId:${JSON.stringify(randomUUID())}}) });
      const body = await response.json();
      return {status:response.status, correlated:response.headers.get('X-Request-Id')===body.error?.requestId,
        code:body.error?.code};
    })()`, 20_000);
    assert.deepEqual(await probe(harborCartPrompt + '\n'), { status: 404, correlated: true, code: 'RESOURCE_NOT_FOUND' });
    assert.ok(!reachedWriteBoundary, 'Rejected prompt reached write boundary');
    assert.deepEqual(await probe(harborCartPrompt), { status: 503, correlated: true, code: 'DEPENDENCY_UNAVAILABLE' });
    assert.ok(reachedWriteBoundary && ownedScopeRead, 'Valid request did not reach the non-admitting boundary');
    assert.ok(await readSecondScope(context.primary, identity, digest), 'Harbor Cart changed');
    assert.ok(JSON.stringify(await readFirstExperiment(context.primary, first, identity)) === JSON.stringify(before),
      'Lantern Locker changed');
    console.info('Harbor Cart verified. Changed bytes denied, exact bytes reached the write-disabled boundary, request IDs correlated, and both scopes preserved.');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await Promise.allSettled(clients.map(client => client.$disconnect()));
    await Promise.allSettled(pools.map(pool => pool.end()));
  }
}
