/** Explicit local P9 composition. The production entry points remain inert. */
import { createPublicKey } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { createExecutionAuthorizer, createContextGrantIssuer } from '../apps/api/dist/generation/execution-scope.js';
import { createRuntimeRecoveryClearance } from '../apps/api/dist/privacy/runtime-recovery-clearance.js';
import { createSuppressionLedger } from '../apps/api/dist/security/suppression-ledger.js';
import { generationReservationTokens, localGenerationPolicy } from '../apps/api/dist/generation/local-policy.js';
import { isUuid } from '../apps/dispatcher/dist/config.js';
import { dispatcher } from '../apps/dispatcher/dist/dispatch.js';
import { generationQueue } from '../apps/dispatcher/dist/generation-queue.js';
import { outboxRepository } from '../apps/dispatcher/dist/outbox-repository.js';
import { deterministicFounderProvider, founderPrompt, geminiFounderProvider, syntheticOnlyProvider } from '../apps/worker/dist/founder-provider.js';
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
  const test = env.FL_P9_DISPOSABLE === '1';
  if (env.NODE_ENV === 'production' || (!gemini && env.FL_P9_LOCAL_RUNTIME !== 'deterministic') ||
    env.P9_GEMINI_MODEL !== 'gemini-3.1-flash-lite' ||
    (gemini ? test || env.FL_P9_GEMINI_CONFIRM !== 'approve-one-synthetic-invocation' || env.FL_P9_MAX_ADMISSIONS !== '1'
      : Boolean(env.P9_GEMINI_API_KEY)) || ((deterministicProvider || afterOfflineObservation) && (gemini || !test))) {
    throw new Error('Local generation runtime unavailable');
  }
  const required = key => {
    if (!env[key]) throw new Error('Missing local runtime configuration');
    return env[key];
  };
  const approved = { accountId: required('FL_P9_SYNTHETIC_ACCOUNT'), conversationId: required('FL_P9_SYNTHETIC_CONVERSATION') };
  const run = required('FL_P9_REDIS_RUN');
  if (![run, approved.accountId, approved.conversationId].every(isUuid)) throw new Error('Invalid local runtime scope');
  const textHash = required('FL_P9_SYNTHETIC_TEXT_SHA256');
  const budget = gemini ? localGenerationPolicy({
    model: required('P9_GEMINI_MODEL'), priceVersion: required('FL_P9_PRICE_VERSION'),
    maximumMicrosPerMillionTokens: required('FL_P9_MAX_MICROS_PER_MILLION_TOKENS'),
    budgetMicros: required('FL_P9_BUDGET_MICROS'), tokenBudget: required('FL_P9_ACCOUNT_TOKEN_BUDGET'),
    requestsPerMinute: required('FL_P9_REQUESTS_PER_MINUTE'), maximumAdmissions: required('FL_P9_MAX_ADMISSIONS'),
    ...approved, syntheticTextSha256: textHash
  }).policy : undefined;
  const provider = syntheticOnlyProvider(gemini ? geminiFounderProvider(env) :
    deterministicProvider ?? deterministicFounderProvider(), textHash);
  const redis = localUrl(required('FL_P9_REDIS_URL'), 'redis:', '56381');
  if (redis.pathname !== '/0' || redis.username || !/^[a-f0-9]{64}$/.test(redis.password)) throw new Error('Invalid local broker');
  const prefix = 'founders-lens-p9-local-' + run;
  const primaryPort = test ? '55435' : '55437', authorityPort = test ? '55438' : '55436';
  const database = test ? '/founders_lens_m05_e2e_test' : '/founders_lens_p6_local';
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
    await Promise.allSettled([pump?.close(), consumer?.close(), running]);
    const results = await Promise.allSettled(resources.map(value => value.end()));
    if (results.some(result => result.status === 'rejected')) report('P9_DATABASE_CLOSE_FAILED');
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
        if (gemini || deterministicProvider) return result;
        report('P9_DETERMINISTIC_INVOCATION');
        // Fixed synthetic observation for the deterministic runtime, never a Gemini receipt.
        return { ...result, responseId: 'p9-deterministic-observation',
          usage: { inputTokens: 17, outputTokens: 9, totalTokens: 26 } };
      }, {
        verifyExecution: ({ id }) => execute(id),
        readContext: leasedContextReader(workerPool,
          createContextGrantIssuer(verifier, ledger.authority, executionPermission, urls[2].username, approved))
      });
    consumer = generationConsumer(redis, prefix, worker);
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
    pump = dispatcher(outboxRepository(dispatchPool, approved), generationQueue(redis, prefix),
      () => Promise.reject(new Error('Independent verification required')), outcome => report(outcome), {
        verifyExecution: createExecutionAuthorizer(verifier, ledger.authority, dispatchPermission, 'dispatch', approved)
      });
    const duration = Math.min(dispatch.expiresAt, execution.expiresAt) - Date.now();
    if (duration <= 0) throw new Error('Local execution window expired');
    expiryTimer = setTimeout(() => { report('P9_PERMISSION_EXPIRED'); void close(); }, duration);
    // Redis may have acknowledged delivery before a claimant exited. Recover
    // only expired leases from the approved conversation, through the same
    // authorization and single-invocation fences as normal delivery.
    async function recoverExpiredLeases() {
      while (!abort.signal.aborted) {
        try {
          const { rows } = await workerPool.query(`SELECT g.id FROM public."GenerationAttempt" g
            JOIN public."Conversation" c ON c.id=g."conversationId"
            JOIN public."Idea" i ON i.id=c."ideaId"
            WHERE c.id=$1 AND i."ownerId"=$2 AND g.status='RUNNING'
              AND g."leaseUntil"<=clock_timestamp() AND g."deadlineAt">clock_timestamp()
            ORDER BY g."leaseUntil",g.id LIMIT 4`, [approved.conversationId, approved.accountId]);
          if (!abort.signal.aborted && rows.length > 0) await worker.recover(rows.map(row => row.id));
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
    await close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const runtime = await startLocalGeneration(process.env, event => console.log(JSON.stringify({ event })));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void runtime.close());
    await runtime.finished;
    await runtime.close();
  } catch {
    console.error(JSON.stringify({ event: 'P9_LOCAL_STARTUP_DENIED' }));
    process.exitCode = 1;
  }
}
