// Local-only composition for idea listing and optionally creation. Runtime uses restricted
// database logins and a public verification key supplied by the operator.
import { createPublicKey, randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { Router, type Request, type RequestHandler } from 'express';
import pg from 'pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { createRuntimeRecoveryClearance, type RuntimeRecoveryDecision } from '../privacy/runtime-recovery-clearance.js';
import { createClerkBoundary } from '../security/clerk.js';
import { clerkConfig } from '../security/config.js';
import { SecurityError } from '../security/errors.js';
import { isConversationSubmission, requestContext, traceSubmissionFailure } from '../security/request-context.js';
import { ClerkIdentityProvider } from '../security/identity-provider.js';
import { PrismaIdentityRepository } from '../security/identity-repository.js';
import { IdentityService } from '../security/identity-service.js';
import { SubjectKeys } from '../security/subject-key.js';
import { createSuppressionLedger } from '../security/suppression-ledger.js';
import { createSubmissionRepository } from '../submission/repository.js';
import { submissionRoutes } from '../submission/routes.js';
import { createSubmissionService, type SubmissionService } from '../submission/service.js';
import { createGenerationRepository } from '../generation/repository.js';
import { generationRoutes } from '../generation/routes.js';
import { createGenerationService } from '../generation/service.js';
import { localGenerationModel, localGenerationPolicy } from '../generation/local-policy.js';
import { cedarAcceptanceEnabled, cedarAcceptanceTarget, cedarRecheckTarget } from '../generation/cedar-acceptance-target.js';
import { WorkspaceCursor } from './contracts.js';
import { WorkspaceRepository } from './repository.js';
import { localConversationRoutes, workspaceIdeaListRoutes, type LocalConversationOperations } from './routes.js';
import { localConversationOperations } from './local-conversations.js';
import { WorkspaceService } from './service.js';

const origin = 'http://127.0.0.1:3000';

/** Limit local browser access to the exact configured ideas endpoint and methods. */
export function workspaceIdeasCors(allowCreate: boolean, conversations?: { create: boolean; save: boolean },
  generationConversation?: string): RequestHandler {
  return (request, response, next) => {
    const path = request.path;
    const allowSubmission = Boolean(generationConversation);
    const ideas = path === '/ideas';
    const conversationCollection = /^\/ideas\/[^/]+\/conversations$/.test(path);
    const conversationRead = conversations && (conversationCollection || /^\/ideas\/[^/]+$/.test(path) ||
      /^\/conversations\/[^/]+(?:\/messages)?$/.test(path));
    const save = conversations?.save && /^\/conversations\/[^/]+\/messages\/save$/.test(path);
    const submit = allowSubmission && /^\/conversations\/[^/]+\/messages$/.test(path);
    const generationRead = allowSubmission && (submit || /^\/generations\/[^/]+$/.test(path) ||
      /^\/conversations\/[^/]+\/submissions\/[^/]+$/.test(path));
    const allowRead = ideas || conversationRead || generationRead;
    const postHeaders = (ideas && allowCreate) || save || submit ? 'authorization,content-type,idempotency-key' :
      (conversations?.create && conversationCollection ? 'authorization,content-type' : undefined);
    const rejectRoute = (status: 403 | 404) => {
      if (isConversationSubmission(request.method, path)) {
        traceSubmissionFailure(response, status, request.baseUrl === '/api/v1'
          ? 'SUBMISSION_CAPABILITY_DENIED' : 'WRONG_ROUTE');
      }
      response.status(status).end();
    };
    if (request.baseUrl !== '/api/v1' || !(allowRead || save)) { rejectRoute(404); return; }
    response.vary('Origin');
    const caller = request.get('Origin');
    if (caller && caller !== origin) { rejectRoute(403); return; }
    if (caller === origin) response.set({ 'Access-Control-Allow-Origin': origin,
      'Access-Control-Expose-Headers': 'X-Request-Id, X-Workspace-Idea-Creation, X-Workspace-Conversations, X-Workspace-Generation' });
    if (request.method === 'GET' && generationConversation && path === '/conversations/' + generationConversation) {
      response.set('X-Workspace-Generation', 'enabled');
    }
    if (request.method === 'GET' && allowCreate) response.set('X-Workspace-Idea-Creation', 'enabled');
    if (request.method === 'GET' && ideas && conversations) response.set('X-Workspace-Conversations', 'enabled');
    const method = request.get('Access-Control-Request-Method');
    const headers = request.get('Access-Control-Request-Headers')?.toLowerCase().split(',').map(value => value.trim()).sort().join(',');
    if (request.method === 'OPTIONS') {
      response.vary('Access-Control-Request-Method').vary('Access-Control-Request-Headers');
      if (caller === origin && ((method === 'GET' && allowRead && headers === 'authorization') ||
        (postHeaders && method === 'POST' && headers === postHeaders))) {
        response.set({ 'Access-Control-Allow-Methods': method, 'Access-Control-Allow-Headers': headers }).status(204).end();
      } else response.status(404).end();
      return;
    }
    if ((request.method !== 'GET' || !allowRead) && (request.method !== 'POST' || !postHeaders)) {
      rejectRoute(404); return;
    }
    next();
  };
}

/** Open the fixed P6 read endpoints and validate signed clearance before mounting. */
export async function localReadOnlyWorkspace(env: NodeJS.ProcessEnv) {
  if (env['FL_P6_READ_ONLY'] !== '1' || env['NODE_ENV'] === 'production') return;
  const isolated = env['FL_P9_ISOLATED'] === '1';
  const cedar = cedarAcceptanceEnabled(env);
  const target = env['FL_P9_CEDAR_ACCEPTANCE'] === '2' ? cedarRecheckTarget : cedarAcceptanceTarget;
  const primaryPort = cedar ? target.primaryPort : isolated ? 55435 : 55437;
  const authorityPort = cedar ? target.authorityPort : isolated ? 55438 : 55436;
  const primaryDatabase = cedar ? target.database : isolated ? 'founders_lens_p9_local' : 'founders_lens_p6_local';
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error('Local workspace configuration unavailable');
    return value;
  };
  const key = (name: string) => {
    const value = required(name);
    if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('Invalid local workspace configuration');
    return Buffer.from(value, 'hex');
  };
  const config = clerkConfig({ ...env, CLERK_PUBLISHABLE_KEY: env['CLERK_PUBLISHABLE_KEY'] ?? env['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY'] });
  if (!config.publishableKey.startsWith('pk_test_') || !config.authorizedParties.includes(origin) ||
    (!config.audience && env['CLERK_TEST_ALLOW_NO_AUDIENCE'] !== '1')) throw new Error('Local Clerk policy unavailable');
  const clerk = createClerkBoundary({ ...config, authorizedParties: [origin] });
  const subjectKeys = new SubjectKeys(1, new Map([[1, key('FL_P6_SUBJECT_KEY_V1')]]));
  const pool = (port: number, database: string, user: string, password: string) => new pg.Pool({
    host: '127.0.0.1', port, database, user, password, max: 4,
    connectionTimeoutMillis: 1500, statement_timeout: 4000, query_timeout: 4500
  });
  const readerPassword = required('FL_SUPPRESSION_READER_PASSWORD');
  const primary = pool(primaryPort, primaryDatabase, 'fl_p6_workspace', required('FL_P6_WORKSPACE_PASSWORD'));
  const authorityPool = pool(authorityPort, 'suppression_proof', 'ledger_reader', readerPassword);
  primary.on('error', () => {});
  authorityPool.on('error', () => {});
  const prisma = new PrismaClient({ adapter: new PrismaPg(primary), log: [], errorFormat: 'minimal' });
  let writePool: pg.Pool | undefined;
  let writeClient: PrismaClient | undefined;
  let conversationPool: pg.Pool | undefined;
  let conversationClient: PrismaClient | undefined;
  let submissionPool: pg.Pool | undefined;
  let submissionClient: PrismaClient | undefined;
  const close = async () => {
    await prisma.$disconnect();
    await writeClient?.$disconnect();
    await writePool?.end();
    await conversationClient?.$disconnect();
    await conversationPool?.end();
    await submissionClient?.$disconnect();
    await submissionPool?.end();
    await Promise.all([primary.end(), authorityPool.end()]);
  };
  try {
    const authority = createSuppressionLedger(authorityPool, { epoch: required('FL_P6_AUTHORITY_EPOCH'),
      challengeNamespace: required('FL_P6_AUTHORITY_NAMESPACE'), subjectVersions: [1], integrityKey: key('FL_P6_INTEGRITY_KEY') });
    const operatorPublicKey = createPublicKey({ key: Buffer.from(required('FL_P6_OPERATOR_PUBLIC_KEY'), 'base64'),
      type: 'spki', format: 'der' });
    const clearance = createRuntimeRecoveryClearance({ decision: required('FL_P6_RECOVERY_DECISION'),
      operatorPublicKey, primary, authority, subjectKeys });
    await clearance.assertClearance();
    const repo = new PrismaIdentityRepository(prisma);
    const identity = new IdentityService(config.instanceId, subjectKeys, new ClerkIdentityProvider(clerk.client),
      { resolve: repo.resolveExisting.bind(repo) }, authority.authority);
    const cursorKey = key('FL_P6_CURSOR_KEY');
    const cursor = new WorkspaceCursor(cursorKey);
    const workspace = new WorkspaceService(new WorkspaceRepository(prisma), cursor, authority.authority);
    let create: Pick<WorkspaceService, 'createIdea'> | undefined;
    if (env['FL_P7_CREATE_IDEA'] === '1') {
      try {
        const decision = required('FL_P7_CREATE_IDEA_DECISION');
        writePool = pool(primaryPort, primaryDatabase, 'fl_p7_idea_create', required('FL_P7_IDEA_CREATE_PASSWORD'));
        writePool.on('error', () => {});
        const writeClearance = createRuntimeRecoveryClearance({ decision, operatorPublicKey,
          primary: writePool, authority, subjectKeys, purpose: 'founders-lens:local-workspace:create-idea' });
        await writeClearance.assertClearance();
        writeClient = new PrismaClient({ adapter: new PrismaPg(writePool), log: [], errorFormat: 'minimal' });
        const writer = new WorkspaceService(new WorkspaceRepository(writeClient), cursor, authority.authority);
        create = { createIdea: (principal, key, body) => writer.createIdea(principal, key, body, writeClearance.verifiedDeadline) };
      } catch {
        await writePool?.end();
        writePool = undefined;
      }
    }
    let conversations: LocalConversationOperations | undefined;
    if (env['FL_P8_CONVERSATIONS'] === '1') {
      try {
        const target = pool(primaryPort, primaryDatabase, 'fl_p8_conversations', required('FL_P8_CONVERSATIONS_PASSWORD'));
        conversationPool = target;
        target.on('error', () => {});
        const permission = async (name: string, purpose: RuntimeRecoveryDecision['purpose']) => {
          const verifier = createRuntimeRecoveryClearance({ decision: required(name), operatorPublicKey,
            primary: target, authority, subjectKeys, purpose });
          await verifier.assertClearance();
          return verifier.verifiedDeadline;
        };
        const read = await permission('FL_P8_READ_DECISION', 'founders-lens:local-workspace:read-conversations');
        const create = await permission('FL_P8_CREATE_DECISION', 'founders-lens:local-workspace:create-conversation').catch(() => undefined);
        const save = await permission('FL_P8_SAVE_DECISION', 'founders-lens:local-workspace:save-user-message').catch(() => undefined);
        conversationClient = new PrismaClient({ adapter: new PrismaPg(target), log: [], errorFormat: 'minimal' });
        conversations = localConversationOperations(conversationClient, authority.authority, cursorKey,
          { read, ...(create && { create }), ...(save && { save }) });
      } catch {
        await conversationPool?.end();
        conversationPool = undefined;
      }
    }
    let submission: SubmissionService | undefined;
    let generation: ReturnType<typeof createGenerationService> | undefined;
    let generationReadDeadline: (() => Promise<number>) | undefined;
    let generationConversation: string | undefined;
    if (env['FL_P9_SUBMIT'] === '1') {
      try {
        if (env['GROQ_API_KEY']) throw new Error('Unexpected credential in API environment');
        const target = pool(primaryPort, primaryDatabase, 'fl_p9_submit', required('FL_P9_SUBMIT_PASSWORD'));
        submissionPool = target;
        target.on('error', () => {});
        const admission = createRuntimeRecoveryClearance({ decision: required('FL_P9_SUBMIT_DECISION'),
          operatorPublicKey, primary: target, authority, subjectKeys, purpose: 'founders-lens:local-generation:submit' });
        const submitDecision = await admission.verifiedDecision();
        const status = createRuntimeRecoveryClearance({ decision: required('FL_P9_STATUS_DECISION'),
          operatorPublicKey, primary: target, authority, subjectKeys, purpose: 'founders-lens:local-generation:status' });
        const statusDecision = await status.verifiedDecision();
        if (submitDecision.recoveryRun !== statusDecision.recoveryRun) throw new Error('Generation decisions differ');
        const approvedConversation = required('FL_P9_SYNTHETIC_CONVERSATION');
        const { policy, allows } = localGenerationPolicy({
          model: localGenerationModel(env), priceVersion: required('FL_P9_PRICE_VERSION'),
          maximumMicrosPerMillionTokens: required('FL_P9_MAX_MICROS_PER_MILLION_TOKENS'),
          budgetMicros: required('FL_P9_BUDGET_MICROS'), tokenBudget: required('FL_P9_ACCOUNT_TOKEN_BUDGET'),
          requestsPerMinute: required('FL_P9_REQUESTS_PER_MINUTE'), maximumAdmissions: required('FL_P9_MAX_ADMISSIONS'),
          accountId: required('FL_P9_SYNTHETIC_ACCOUNT'), conversationId: approvedConversation,
          syntheticTextSha256: required('FL_P9_SYNTHETIC_TEXT_SHA256')
        });
        submissionClient = new PrismaClient({ adapter: new PrismaPg(target), log: [], errorFormat: 'minimal' });
        generation = createGenerationService(createGenerationRepository(submissionClient, policy),
          authority.authority, status.verifiedDeadline, approvedConversation);
        generationReadDeadline = status.verifiedDeadline;
        generationConversation = approvedConversation;
        submission = createSubmissionService(createSubmissionRepository(submissionClient), authority.authority, {
          executionAdmission: admission.verifiedDecision, clock: () => new Date(), policy, cursorSecret: cursorKey,
          allowSubmission: (principal, conversationId, content) => allows(principal.localUserId, conversationId, content)
        });
      } catch {
        await submissionClient?.$disconnect();
        await submissionPool?.end();
        submissionClient = undefined;
        submissionPool = undefined;
      }
    }
    const router = Router();
    router.use(workspaceIdeasCors(Boolean(create), conversations && { create: Boolean(conversations.create), save: Boolean(conversations.save) },
      generationConversation));
    const authenticate = async (request: Request) => {
      const verified = await clerk.authenticate(request.headers, request.rawHeaders);
      if (!config.audience && Object.hasOwn(JSON.parse(Buffer.from(request.get('Authorization')!.split('.')[1]!, 'base64url').toString()), 'aud')) {
        throw new SecurityError('UNAUTHENTICATED');
      }
      await clearance.assertClearance();
      return identity.resolve(verified, request.res ? requestContext(request.res).requestId : randomUUID());
    };
    router.use(workspaceIdeaListRoutes({ ideas(principal, query) {
      return workspace.ideas(principal, query, clearance.assertClearance);
    } }, authenticate, create));
    if (submission && generation && generationReadDeadline && generationConversation) {
      router.use(submissionRoutes(submission, authenticate, { readDeadline: generationReadDeadline,
        readConversation: generationConversation }));
      router.use(generationRoutes(generation, authenticate, { statusOnly: true }));
    }
    if (conversations) router.use(localConversationRoutes(conversations, authenticate));
    return { router, close };
  } catch (error) {
    await close();
    throw error;
  }
}
