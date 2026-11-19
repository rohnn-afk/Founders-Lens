// Persistence adapter. Callers build a Prisma Client here so database access
// uses validated configuration and one place defines connection limits.

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { databaseConfig } from './config.js';

// Construction does not enable private routes or change API readiness.
// The caller owns the lifecycle and must await $disconnect().
export function createDatabaseClient(environment: NodeJS.ProcessEnv = process.env): PrismaClient {
  const { connectionString } = databaseConfig(environment);
  // A connection pool reuses database connections across queries. Its size and
  // wait limits bound how much database work one client can hold open.
  const adapter = new PrismaPg({
    connectionString,
    max: 4,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    statement_timeout: 5_000,
    application_name: 'founders-lens-m02-runtime'
  }, { schema: 'public' });
  return new PrismaClient({
    adapter,
    log: [],
    errorFormat: 'minimal',
    transactionOptions: { maxWait: 5_000, timeout: 5_000 }
  });
}
