// Database tooling configuration. The Prisma CLI reads schema and migration
// paths here. The runtime API constructs its database client separately.

import { defineConfig } from 'prisma/config';

// Generation and validation work offline without database credentials.
// Only the guarded database tool supplies URLs for migration execution.
const url = process.env['MIGRATION_DATABASE_URL'];
// A shadow database is scratch space for Prisma development workflows that
// replay migrations. Its URL is optional and separate from the main target.
const shadow = process.env['SHADOW_DATABASE_URL'];

export default defineConfig({
  schema: 'apps/api/prisma/schema.prisma',
  migrations: { path: 'apps/api/prisma/migrations' },
  ...(url ? { datasource: { url, ...(shadow ? { shadowDatabaseUrl: shadow } : {}) } } : {})
});
