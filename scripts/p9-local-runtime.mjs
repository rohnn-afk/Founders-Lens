/** Explicit local P9 composition. The production entry points remain inert. */
import { createPublicKey } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { createExecutionAuthorizer, createContextGrantIssuer } from '../apps/api/dist/generation/execution-scope.js';
import { createRuntimeRecoveryClearance } from '../apps/api/dist/privacy/runtime-recovery-clearance.js';
import { createSuppressionLedger } from '../apps/api/dist/security/suppression-ledger.js';
import { generationReservationTokens, localGenerationModel, localGenerationPolicy } from '../apps/api/dist/generation/local-policy.js';
import { cedarAcceptanceEnabled, cedarAcceptanceTarget, cedarRecheckTarget, offlineAcceptanceEnabled,
  offlineAcceptanceTarget, offlineDevelopmentEnabled } from '../apps/api/dist/generation/cedar-acceptance-target.js';
import { isUuid } from '../apps/dispatcher/dist/config.js';
import { dispatcher } from '../apps/dispatcher/dist/dispatch.js';
import { generationQueue } from '../apps/dispatcher/dist/generation-queue.js';
import { outboxRepository } from '../apps/dispatcher/dist/outbox-repository.js';
import { deterministicFounderProvider, founderPrompt, geminiFounderProvider, syntheticOnlyProvider } from '../apps/worker/dist/founder-provider.js';
import { groqFounderProvider } from '../apps/worker/dist/groq-provider.js';
import { generationConsumer } from '../apps/worker/dist/generation-consumer.js';
import { generationRepository } from '../apps/worker/dist/generation-repository.js';
import { generationWorker } from '../apps/worker/dist/generation-worker.js';
import { leasedContextReader } from '../apps/worker/dist/leased-context-reader.js';

const identityQuery = `SELECT system_identifier::text || ':' || d.oid::text AS identity,
  session_user AS login, has_schema_privilege('public','CREATE') AS ddl,
  has_column_privilege('public."Message"','content','SELECT') AS content,
  has_table_privilege('public."ConfirmedMemory"','SELECT') AS memory,
  (SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid)
    FROM pg_catalog.pg_roles r WHERE rolname=session_user) AS privileged
  FROM pg_catalog.pg_control_system(), pg_catalog.pg_database d WHERE d.datname=current_database()`;

function localUrl(input, protocol, port) {
  const result = new URL(input);
  if (result.protocol !== protocol || result.hostname !== '127.0.0.1' || result.port !== port ||
    result.hash || result.search || !result.password) throw new Error('Invalid loopback runtime target');
  return result;
}

/** Verify exact signed targets, roles and synthetic scope before starting either loop. */
export async function startLocalGeneration(env, report = () => {}, { deterministicProvider, afterOfflineObservation } = {}) {
  const gemini = env.FL_P9_LOCAL_RUNTIME === 'gemini';
  const groq = env.FL_P9_LOCAL_RUNTIME === 'groq';
  const live = gemini || groq;
  const test = env.FL_P9_DISPOSABLE === '1';
  const isolated = env.FL_P9_ISOLATED === '1';
  const cedar = cedarAcceptanceEnabled(env);
  const offline = offlineAcceptanceEnabled(env);
  const offlineDevelopment = offlineDevelopmentEnabled(env);
  const recheck = env.FL_P9_CEDAR_ACCEPTANCE === '2';
  const target = offline ? offlineAcceptanceTarget : recheck ? cedarRecheckTarget : cedarAcceptanceTarget;
  const dedicated = cedar || offline;
  const brokerProfile = offline ? 'offline' : recheck ? 'cedar-recheck' : cedar ? 'cedar' : test;
  if (env.NODE_ENV === 'production' || (!live && env.FL_P9_LOCAL_RUNTIME !== 'deterministic') ||
    env.GROQ_API_KEY || (cedar && !groq) ||
    (test && isolated) ||
    (live && (test || !isolated || env.FL_P9_MAX_ADMISSIONS !== '1')) ||
    (gemini && env.FL_P9_GEMINI_CONFIRM !== 'approve-one-synthetic-invocation') ||
    (groq && env.FL_P9_GROQ_CONFIRM !== 'approve-one-synthetic-invocation') ||
    (!gemini && env.P9_GEMINI_API_KEY) || ((deterministicProvider || afterOfflineObservation) && (live || !test))) {
    throw new Error('Local generation runtime unavailable');
  }
  const model = localGenerationModel(env);
  if ((groq && model !== 'openai/gpt-oss-20b') || (gemini && model !== 'gemini-3.1-flash-lite') ||
    (!live && !test && model === 'openai/gpt-oss-20b')) {
    throw new Error('Local generation provider and model differ');
  }
  const required = key => {
    if (!env[key]) throw new Error('Missing local runtime configuration');
    return env[key];
  };
  const approved = { accountId: required('FL_P9_SYNTHETIC_ACCOUNT'), conversationId: required('FL_P9_SYNTHETIC_CONVERSATION') };
  const run = required('FL_P9_REDIS_RUN');
  if (![run, approved.accountId, approved.conversationId].every(isUuid)) throw new Error('Invalid local runtime scope');
  const textHash = offlineDevelopment ? undefined : required('FL_P9_SYNTHETIC_TEXT_SHA256');
  const budget = live || model === 'openai/gpt-oss-20b' ? localGenerationPolicy({
    model, priceVersion: required('FL_P9_PRICE_VERSION'),
    maximumMicrosPerMillionTokens: required('FL_P9_MAX_MICROS_PER_MILLION_TOKENS'),
    budgetMicros: required('FL_P9_BUDGET_MICROS'), tokenBudget: required('FL_P9_ACCOUNT_TOKEN_BUDGET'),
    requestsPerMinute: required('FL_P9_REQUESTS_PER_MINUTE'), maximumAdmissions: required('FL_P9_MAX_ADMISSIONS'),
    ...approved, syntheticTextSha256: textHash
  }).policy : undefined;
  const groqKey = groq ? parseEnv(await readFile(new URL('../.env.p9-groq-worker.local', import.meta.url), 'utf8')).GROQ_API_KEY : undefined;
  const provider = textHash ? syntheticOnlyProvider(gemini ? geminiFounderProvider(env, undefined, report)
    : groq ? groqFounderProvider(groqKey, undefined, report) : deterministicProvider ?? deterministicFounderProvider(), textHash)
    : deterministicFounderProvider({ contextual: true });
  const redis = localUrl(required('FL_P9_REDIS_URL'), 'redis:', dedicated ? String(target.redisPort) : test ? '56382' : '56381');
  if (redis.pathname !== '/0' || redis.username || !/^[a-f0-9]{64}$/.test(redis.password)) throw new Error('Invalid local broker');
  const prefix = 'founders-lens-p9-local-' + run;
  const primaryPort = dedicated ? String(target.primaryPort) : test ? '55439' : isolated ? '55435' : '55437';
  const authorityPort = dedicated ? String(target.authorityPort) : test ? '55440' : isolated ? '55438' : '55436';
  const database = dedicated ? '/' + target.database : test ? '/founders_lens_m05_e2e_test' : isolated ? '/founders_lens_p9_local' : '/founders_lens_p6_local';
  const resources = [];
  function pool(url, path) {
    if (url.pathname !== path || !/^[a-z][a-z0-9_]{0,62}$/.test(url.username)) throw new Error('Invalid database login');
    const result = new pg.Pool({ connectionString: url.href, max: 3, connectionTimeoutMillis: 1500,
      statement_timeout: 2500, query_timeout: 3000 });
    result.on('error', () => report('P9_DATABASE_CONNECTION_LOST'));
    resources.push(result);
    return result;
  }
  const abort = new AbortController();
  let pump, consumer, running, expiryTimer, closing;
  const close = () => closing ??= (async () => {
    abort.abort();
    clearTimeout(expiryTimer);
    const loops = await Promise.allSettled([pump?.close(), consumer?.close(), running]);
    const pools = await Promise.allSettled(resources.map(value => value.end()));
    if ([...loops.slice(0, 2), ...pools].some(result => result.status === 'rejected')) {
      throw new Error('Local generation cleanup failed');
    }
  })();
  try {
    const urls = ['DISPATCH', 'VERIFIER', 'WORKER'].map(role =>
      localUrl(required('FL_P9_' + role + '_DATABASE_URL'), 'postgresql:', primaryPort));
    const expected = ['fl_p9_dispatch', 'fl_p9_context_verifier', 'fl_p9_worker'];
    if (urls.some((url, index) => url.username !== expected[index])) throw new Error('Dedicated runtime logins required');
    const [dispatchPool, verifier, workerPool] = urls.map(url => pool(url, database));
    const authorityUrl = localUrl(required('FL_P9_AUTHORITY_DATABASE_URL'), 'postgresql:', authorityPort);
    if (authorityUrl.username !== 'ledger_reader') throw new Error('Authority reader required');
    const authorityReader = pool(authorityUrl, '/suppression_proof');
    const versions = required('FL_P9_RETAINED_VERSIONS').split(',').map(Number);
    const integrity = required('FL_P6_INTEGRITY_KEY');
    if (!/^[a-f0-9]{64}$/.test(integrity)) throw new Error('Invalid authority integrity configuration');
    const ledger = createSuppressionLedger(authorityReader, { epoch: required('FL_P6_AUTHORITY_EPOCH'),
      challengeNamespace: required('FL_P6_AUTHORITY_NAMESPACE'), integrityKey: Buffer.from(integrity, 'hex'), subjectVersions: versions });
    const publicKey = createPublicKey({ key: Buffer.from(required('FL_P6_OPERATOR_PUBLIC_KEY'), 'base64'), format: 'der', type: 'spki' });
    const permission = purpose => createRuntimeRecoveryClearance({
      decision: required('FL_P9_' + purpose.toUpperCase() + '_DECISION'), operatorPublicKey: publicKey,
      primary: verifier, authority: ledger, retainedSubjectVersions: versions, purpose: 'founders-lens:local-generation:' + purpose
    }).verifiedDecision;
    const dispatchPermission = permission('dispatch'), executionPermission = permission('execute');
    const [dispatch, execution] = await Promise.all([dispatchPermission(), executionPermission()]);
    if (dispatch.primaryTarget !== execution.primaryTarget || dispatch.authorityIdentity !== execution.authorityIdentity ||
      dispatch.recoveryRun !== execution.recoveryRun) throw new Error('Decision targets differ');
    const identities = await Promise.all([dispatchPool, verifier, workerPool].map(connection => connection.query(identityQuery)));
    for (const [index, result] of identities.entries()) {
      const row = result.rows[0];
      if (!row || row.identity !== execution.primaryTarget || row.login !== urls[index].username ||
        row.ddl || row.content || row.memory || row.privileged !== false) throw new Error('Runtime login privileges unavailable');
    }
    const scope = await verifier.query(`SELECT c.id FROM public."Conversation" c
      JOIN public."Idea" i ON i.id=c."ideaId" JOIN public."UserAccount" a ON a.id=i."ownerId"
      WHERE c.id=$1 AND a.id=$2 AND c.status='ACTIVE' AND i.status='ACTIVE' AND a.status='ACTIVE'`,
    [approved.conversationId, approved.accountId]);
    if (scope.rowCount !== 1) throw new Error('Approved local scope unavailable');
    const work = generationRepository(workerPool, { bindClaimant: true, singleInvocation: true, metered: true,
      ...(env.FL_P9_MAX_ADMISSIONS === '1' && {
        oneInvocationReservation: budget?.reservationUnits ?? generationReservationTokens
      }) });
    // The disposable fault seam runs after the accounting transaction commits
    // and before the coordinator starts its independent publication check.
    const repository = afterOfflineObservation ? { ...work, async recordUsage(...args) {
      const recorded = await work.recordUsage(...args);
      if (recorded) await afterOfflineObservation();
      return recorded;
    } } : work;
    const execute = createExecutionAuthorizer(verifier, ledger.authority, executionPermission, 'execute', approved);
    const worker = generationWorker(repository, () => Promise.reject(new Error('Independent verification required')), isUuid,
      undefined, Date.now, async (context, signal) => {
        const result = await provider.generate(founderPrompt(context), signal);
        if (live || deterministicProvider) return result;
        report('P9_DETERMINISTIC_INVOCATION');
        // Fixed synthetic observation for the deterministic runtime, never a Gemini receipt.
        return { ...result, responseId: 'p9-deterministic-observation',
          usage: { inputTokens: 17, outputTokens: 9, totalTokens: 26 } };
      }, {
        structuredOffline: offline || test && !deterministicProvider,
        verifyExecution: ({ id }) => execute(id),
        readContext: leasedContextReader(workerPool,
          createContextGrantIssuer(verifier, ledger.authority, executionPermission, urls[2].username, approved))
      });
    consumer = generationConsumer(redis, prefix, worker, brokerProfile);
    const brokerTimer = setTimeout(() => abort.abort(), 4000);
    const onAbort = () => consumer.close().catch(() => {});
    abort.signal.addEventListener('abort', onAbort, { once: true });
    try {
      await Promise.race([consumer.waitUntilReady(), new Promise((_, reject) =>
        abort.signal.addEventListener('abort', () => reject(new Error('Local broker unavailable')), { once: true }))]);
    } finally {
      clearTimeout(brokerTimer);
      abort.signal.removeEventListener('abort', onAbort);
    }
    const outbox = outboxRepository(dispatchPool, approved);
    pump = dispatcher(outbox, generationQueue(redis, prefix, undefined, brokerProfile),
      () => Promise.reject(new Error('Independent verification required')), outcome => report(outcome), {
        verifyExecution: createExecutionAuthorizer(verifier, ledger.authority, dispatchPermission, 'dispatch', approved)
      });
    const duration = Math.min(dispatch.expiresAt, execution.expiresAt) - Date.now();
    if (duration <= 0) throw new Error('Local execution window expired');
    expiryTimer = setTimeout(() => {
      report('P9_PERMISSION_EXPIRED');
      // The CLI's finally block observes the same memoized shutdown promise.
      void close().catch(() => {});
    }, duration);
    // Redis may have acknowledged delivery before a claimant exited. Recover
    // only expired leases from the approved conversation, through the same
    // authorization and single-invocation fences as normal delivery.
    async function recoverExpiredLeases() {
      while (!abort.signal.aborted) {
        try {
          const { rows } = await workerPool.query(`SELECT g.id,g."deadlineAt"<=clock_timestamp() AS expired
            FROM public."GenerationAttempt" g
            JOIN public."Conversation" c ON c.id=g."conversationId"
            JOIN public."Idea" i ON i.id=c."ideaId"
            JOIN public."UsageLedger" u ON u."reservationId"=g.id AND u."accountId"=i."ownerId"
            WHERE c.id=$1 AND i."ownerId"=$2 AND u.unit='tokens' AND u."operationType"='generation'
              AND (g."leaseUntil" IS NULL OR g."leaseUntil"<=clock_timestamp())
              AND (g.status='RUNNING' OR
                (g.status IN ('PENDING','CANCEL_REQUESTED') AND g."deadlineAt"<=clock_timestamp()))
            ORDER BY g."leaseUntil",g.id LIMIT 4`, [approved.conversationId, approved.accountId]);
          for (const row of rows) {
            if (abort.signal.aborted) break;
            if (row.expired) await work.expireMetered(row.id, approved);
            else await worker.recover([row.id]);
          }
          if (!abort.signal.aborted) {
            const published = await outbox.publishedCandidates();
            if (published.length) await pump.reconcile(published);
          }
        } catch { report('P9_RECOVERY_UNAVAILABLE'); }
        if (!abort.signal.aborted) await sleep(1000, undefined, { signal: abort.signal }).catch(error => {
          if (error.name !== 'AbortError') throw error;
        });
      }
    }
    running = Promise.all([pump.run(abort.signal), recoverExpiredLeases()]);
    report('P9_LOCAL_READY');
    return { close, finished: running };
  } catch (error) {
    try { await close(); } catch { report('P9_SHUTDOWN_FAILED'); }
    throw error;
  }
}

/** Keep startup, loop failures, and resource cleanup observable without leaking configuration. */
export async function runLocalGeneration(start, report) {
  let runtime;
  const stop = () => { if (runtime) void runtime.close().catch(() => {}); };
  try {
    runtime = await start();
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
    await runtime.finished;
  } catch {
    report(runtime ? 'P9_RUNTIME_FAILED' : 'P9_LOCAL_STARTUP_DENIED');
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, stop);
    try { await runtime?.close(); }
    catch { report('P9_SHUTDOWN_FAILED'); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runLocalGeneration(() => startLocalGeneration(process.env, event => console.log(JSON.stringify({ event }))), event => {
    console.error(JSON.stringify({ event }));
    process.exitCode = 1;
  });
}
