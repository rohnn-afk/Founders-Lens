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
import { ClerkIdentityProvider } from '../security/identity-provider.js';
import { PrismaIdentityRepository } from '../security/identity-repository.js';
import { IdentityService } from '../security/identity-service.js';
import { SubjectKeys } from '../security/subject-key.js';
import { createSuppressionLedger } from '../security/suppression-ledger.js';
import { WorkspaceCursor } from './contracts.js';
import { WorkspaceRepository } from './repository.js';
import { localConversationRoutes, workspaceIdeaListRoutes, type LocalConversationOperations } from './routes.js';
import { localConversationOperations } from './local-conversations.js';
import { WorkspaceService } from './service.js';

const origin = 'http://127.0.0.1:3000';

/** Limit local browser access to the exact configured ideas endpoint and methods. */
export function workspaceIdeasCors(allowCreate: boolean, conversations?: { create: boolean; save: boolean }): RequestHandler {
  return (request, response, next) => {
    const path = request.path;
    const ideas = path === '/ideas';
    const conversationCollection = /^\/ideas\/[^/]+\/conversations$/.test(path);
    const conversationRead = conversations && (conversationCollection || /^\/ideas\/[^/]+$/.test(path) ||
      /^\/conversations\/[^/]+(?:\/messages)?$/.test(path));
    const save = conversations?.save && /^\/conversations\/[^/]+\/messages\/save$/.test(path);
    const postHeaders = (ideas && allowCreate) || save ? 'authorization,content-type,idempotency-key' :
      (conversations?.create && conversationCollection ? 'authorization,content-type' : undefined);
    if (request.baseUrl !== '/api/v1' || !(ideas || conversationRead || save)) { response.status(404).end(); return; }
    response.vary('Origin');
    const caller = request.get('Origin');
    if (caller && caller !== origin) { response.status(403).end(); return; }
    if (caller === origin) response.set({ 'Access-Control-Allow-Origin': origin,
      'Access-Control-Expose-Headers': 'X-Workspace-Idea-Creation, X-Workspace-Conversations' });
    if (request.method === 'GET' && allowCreate) response.set('X-Workspace-Idea-Creation', 'enabled');
    if (request.method === 'GET' && ideas && conversations) response.set('X-Workspace-Conversations', 'enabled');
    const method = request.get('Access-Control-Request-Method');
    const headers = request.get('Access-Control-Request-Headers')?.toLowerCase().split(',').map(value => value.trim()).sort().join(',');
    if (request.method === 'OPTIONS') {
      response.vary('Access-Control-Request-Method').vary('Access-Control-Request-Headers');
      if (caller === origin && ((method === 'GET' && (ideas || conversationRead) && headers === 'authorization') ||
        (postHeaders && method === 'POST' && headers === postHeaders))) {
        response.set({ 'Access-Control-Allow-Methods': method, 'Access-Control-Allow-Headers': headers }).status(204).end();
      } else response.status(404).end();
      return;
    }
    if ((request.method !== 'GET' || !(ideas || conversationRead)) && (request.method !== 'POST' || !postHeaders)) {
      response.status(404).end(); return;
    }
    next();
  };
}

/** Open the fixed P6 read endpoints and validate signed clearance before mounting. */
export async function localReadOnlyWorkspace(env: NodeJS.ProcessEnv) {
  if (env['FL_P6_READ_ONLY'] !== '1' || env['NODE_ENV'] === 'production') return;
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
  const primary = pool(55437, 'founders_lens_p6_local', 'fl_p6_workspace', required('FL_P6_WORKSPACE_PASSWORD'));
  const authorityPool = pool(55436, 'suppression_proof', 'ledger_reader', readerPassword);
  primary.on('error', () => {});
  authorityPool.on('error', () => {});
  const prisma = new PrismaClient({ adapter: new PrismaPg(primary), log: [], errorFormat: 'minimal' });
  let writePool: pg.Pool | undefined;
  let writeClient: PrismaClient | undefined;
  let conversationPool: pg.Pool | undefined;
  let conversationClient: PrismaClient | undefined;
  const close = async () => {
    await prisma.$disconnect();
    await writeClient?.$disconnect();
    await writePool?.end();
    await conversationClient?.$disconnect();
    await conversationPool?.end();
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
        writePool = pool(55437, 'founders_lens_p6_local', 'fl_p7_idea_create', required('FL_P7_IDEA_CREATE_PASSWORD'));
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
        const target = pool(55437, 'founders_lens_p6_local', 'fl_p8_conversations', required('FL_P8_CONVERSATIONS_PASSWORD'));
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
    const router = Router();
    router.use(workspaceIdeasCors(Boolean(create), conversations && { create: Boolean(conversations.create), save: Boolean(conversations.save) }));
    const authenticate = async (request: Request) => {
      const verified = await clerk.authenticate(request.headers, request.rawHeaders);
      if (!config.audience && Object.hasOwn(JSON.parse(Buffer.from(request.get('Authorization')!.split('.')[1]!, 'base64url').toString()), 'aud')) {
        throw new SecurityError('UNAUTHENTICATED');
      }
      await clearance.assertClearance();
      return identity.resolve(verified, randomUUID());
    };
    router.use(workspaceIdeaListRoutes({ ideas(principal, query) {
      return workspace.ideas(principal, query, clearance.assertClearance);
    } }, authenticate, create));
    if (conversations) router.use(localConversationRoutes(conversations, authenticate));
    return { router, close };
  } catch (error) {
    await close();
    throw error;
  }
}
