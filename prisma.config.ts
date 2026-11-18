import { defineConfig } from 'prisma/config';

// Generation and validation work offline without database credentials.
// Only the guarded database tool supplies URLs for migration execution.
const url = process.env['MIGRATION_DATABASE_URL'];
const shadow = process.env['SHADOW_DATABASE_URL'];

export default defineConfig({
  schema: 'apps/api/prisma/schema.prisma',
  migrations: { path: 'apps/api/prisma/migrations' },
  ...(url ? { datasource: { url, ...(shadow ? { shadowDatabaseUrl: shadow } : {}) } } : {})
});
