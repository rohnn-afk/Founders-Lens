// Local-only composition for one private read route. Runtime uses restricted
// database logins and a public verification key supplied by the operator.
import { createPublicKey, randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { Router } from 'express';
import pg from 'pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { createRuntimeRecoveryClearance } from '../privacy/runtime-recovery-clearance.js';
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
import { workspaceIdeaListRoutes } from './routes.js';
import { WorkspaceService } from './service.js';

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
  const origin = 'http://127.0.0.1:3000';
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
  const close = async () => {
    await prisma.$disconnect();
    await Promise.all([primary.end(), authorityPool.end()]);
  };
  try {
    const authority = createSuppressionLedger(authorityPool, { epoch: required('FL_P6_AUTHORITY_EPOCH'),
      challengeNamespace: required('FL_P6_AUTHORITY_NAMESPACE'), subjectVersions: [1], integrityKey: key('FL_P6_INTEGRITY_KEY') });
    const clearance = createRuntimeRecoveryClearance({ decision: required('FL_P6_RECOVERY_DECISION'),
      operatorPublicKey: createPublicKey({ key: Buffer.from(required('FL_P6_OPERATOR_PUBLIC_KEY'), 'base64'),
        type: 'spki', format: 'der' }), primary, authority, subjectKeys });
    await clearance.assertClearance();
    const repo = new PrismaIdentityRepository(prisma);
    const identity = new IdentityService(config.instanceId, subjectKeys, new ClerkIdentityProvider(clerk.client),
      { resolve: repo.resolveExisting.bind(repo) }, authority.authority);
    const workspace = new WorkspaceService(new WorkspaceRepository(prisma), new WorkspaceCursor(key('FL_P6_CURSOR_KEY')), authority.authority);
    const router = Router();
    router.use((request, response, next) => {
      if (request.baseUrl !== '/api/v1' || request.path !== '/ideas') { response.status(404).end(); return; }
      response.vary('Origin');
      const caller = request.get('Origin');
      if (caller && caller !== origin) { response.status(403).end(); return; }
      if (caller === origin) response.set('Access-Control-Allow-Origin', origin);
      if (request.method === 'OPTIONS' && caller === origin && request.get('Access-Control-Request-Method') === 'GET' &&
        request.get('Access-Control-Request-Headers')?.toLowerCase() === 'authorization') {
        response.vary('Access-Control-Request-Method').vary('Access-Control-Request-Headers');
        response.set({ 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'Authorization' }).status(204).end();
        return;
      }
      next();
    });
    router.use(workspaceIdeaListRoutes({ ideas(principal, query) {
      return workspace.ideas(principal, query, clearance.assertClearance);
    } }, async request => {
      const verified = await clerk.authenticate(request.headers, request.rawHeaders);
      if (!config.audience && Object.hasOwn(JSON.parse(Buffer.from(request.get('Authorization')!.split('.')[1]!, 'base64url').toString()), 'aud')) {
        throw new SecurityError('UNAUTHENTICATED');
      }
      await clearance.assertClearance();
      return identity.resolve(verified, randomUUID());
    }));
    return { router, close };
  } catch (error) {
    await close();
    throw error;
  }
}
