import { createPublicKey, randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { Router, type Request } from 'express';
import pg from 'pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { createClerkBoundary } from '../security/clerk.js';
import { clerkConfig } from '../security/config.js';
import { SecurityError } from '../security/errors.js';
import { ClerkIdentityProvider } from '../security/identity-provider.js';
import { PrismaIdentityRepository } from '../security/identity-repository.js';
import { IdentityService } from '../security/identity-service.js';
import { requestContext } from '../security/request-context.js';
import { SubjectKeys } from '../security/subject-key.js';
import { createSuppressionLedger } from '../security/suppression-ledger.js';
import { WorkspaceCursor } from './contracts.js';
import { localConversationOperations } from './local-conversations.js';
import { workspaceIdeasCors } from './read-only-composition.js';
import { WorkspaceRepository } from './repository.js';
import { localConversationRoutes, workspaceIdeaListRoutes } from './routes.js';
import { WorkspaceService } from './service.js';
import { stagingConfig } from './staging-config.js';
import { stagingDecisions } from './staging-decisions.js';

/** Compose the hosted read surface with independent, expiring operator grants. */
export async function stagingWorkspace(env: NodeJS.ProcessEnv, settings: ReturnType<typeof stagingConfig>) {
  const { required, origin } = settings;
  const source = env['FL_STAGING_DECISION_SOURCE'] ?? 'environment';
  if (source !== 'environment' && source !== 'authority') throw new Error('Invalid staging decision source');
  const staticPair = source === 'environment' ? {
    FL_STAGING_IDEAS_DECISION: required('FL_STAGING_IDEAS_DECISION'),
    FL_STAGING_TRANSCRIPT_DECISION: required('FL_STAGING_TRANSCRIPT_DECISION')
  } : undefined;
  if (source === 'authority' && ('FL_STAGING_IDEAS_DECISION' in env || 'FL_STAGING_TRANSCRIPT_DECISION' in env)) {
    throw new Error('Conflicting staging decision sources');
  }
  const config = clerkConfig(env);
  if (!config.audience || config.authorizedParties.length !== 1 || config.authorizedParties[0] !== origin) {
    throw new Error('Invalid staging Clerk policy');
  }
  const key = (name: string) => {
    const value = required(name);
    if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('Invalid staging key configuration');
    return Buffer.from(value, 'hex');
  };
  const subjectKeys = new SubjectKeys(1, new Map([[1, key('FL_SUBJECT_KEY_V1')]]));
  const cursorKey = key('FL_CURSOR_KEY');
  const operatorPublicKey = createPublicKey({ key: Buffer.from(required('FL_OPERATOR_PUBLIC_KEY'), 'base64'),
    format: 'der', type: 'spki' });
  const pool = (url: URL) => {
    const result = new pg.Pool({
      host: url.hostname, port: Number(url.port || '5432'), database: url.pathname.slice(1),
      user: url.username, password: decodeURIComponent(url.password),
      ssl: url.search === '?sslmode=verify-full' ? { rejectUnauthorized: true, servername: url.hostname } : false,
      max: 4,
      connectionTimeoutMillis: settings.connectionTimeoutMillis, statement_timeout: 4000, query_timeout: 4500 });
    result.on('error', () => console.error(JSON.stringify({
      event: 'staging_database_connection_lost', role: url.username
    })));
    return result;
  };
  const primary = pool(settings.workspace);
  const conversations = pool(settings.conversations);
  const authorityPool = pool(settings.authority);
  const client = (connection: pg.Pool) => new PrismaClient({ adapter: new PrismaPg(connection), log: [], errorFormat: 'minimal' });
  const workspaceDb = client(primary);
  const conversationDb = client(conversations);
  let closing: Promise<void> | undefined;
  function close() {
    closing ??= (async () => {
      const clients = await Promise.allSettled([workspaceDb.$disconnect(), conversationDb.$disconnect()]);
      const pools = await Promise.allSettled([primary.end(), conversations.end(), authorityPool.end()]);
      if ([...clients, ...pools].some(result => result.status === 'rejected')) throw new Error('Staging shutdown incomplete');
    })();
    return closing;
  }

  try {
    const authority = createSuppressionLedger(authorityPool, { epoch: required('FL_AUTHORITY_EPOCH'),
      challengeNamespace: required('FL_AUTHORITY_NAMESPACE'), subjectVersions: [1], integrityKey: key('FL_AUTHORITY_INTEGRITY_KEY') });
    const shared = { hostedStaging: true as const, authority, operatorPublicKey, subjectKeys };
    const verifiedDeadline = stagingDecisions(async () => {
      if (staticPair) return staticPair;
      const { rows } = await authorityPool.query<{ pair: unknown }>(
        'SELECT pair FROM staging_release.read_decisions WHERE singleton');
      return rows[0]?.pair;
    }, shared, primary, conversations);
    async function ready() {
      if (closing) throw new Error('Staging workspace is closing');
      await verifiedDeadline();
    }
    await ready();

    const clerk = createClerkBoundary(config);
    const accounts = new PrismaIdentityRepository(workspaceDb);
    const identity = new IdentityService(config.instanceId, subjectKeys, new ClerkIdentityProvider(clerk.client),
      { resolve: accounts.resolveExisting.bind(accounts) }, authority.authority);
    const workspace = new WorkspaceService(new WorkspaceRepository(workspaceDb), new WorkspaceCursor(cursorKey), authority.authority);
    async function authenticate(request: Request) {
      const verified = await clerk.authenticate(request.headers, request.rawHeaders);
      await ready();
      return identity.resolve(verified, request.res ? requestContext(request.res).requestId : randomUUID());
    }
    const router = Router();
    router.use(workspaceIdeasCors(false, { create: false, save: false }, undefined, origin));
    router.use(workspaceIdeaListRoutes({ ideas: async (principal, query) => {
      const deadline = await verifiedDeadline();
      return workspace.ideas(principal, query, async () => {
        await ready();
        if (Date.now() >= deadline) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
      });
    } }, authenticate));
    router.use(localConversationRoutes(localConversationOperations(conversationDb, authority.authority,
      cursorKey, { read: verifiedDeadline }), authenticate));
    return { router, ready, close };
  } catch (error) {
    await close().catch(() => console.error('Staging shutdown incomplete.'));
    throw error;
  }
}
