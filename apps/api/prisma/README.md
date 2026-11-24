# PostgreSQL and Prisma

- [Schema](schema.prisma) defines the Prisma model used to generate the client.
- [Migrations](migrations/) contain the SQL applied to the application database, including constraints that Prisma does not express.
- [Privileges](privileges.sql) defines database role permissions for the baseline. Runtime-specific grants live with their procedures and fixtures.
- [CLI configuration](../../../prisma.config.ts) selects the executable schema and migrations. [Database tooling](../scripts/database.mjs) implements guarded local plan, provision, and migrate commands.

Use `npm run db:generate` to generate the client and `npm run db:validate` to check the schema. Consult the [local configuration reference](../../../.env.example) before running commands that connect to a database. Use the [operator runbooks](../../../Docs/runbooks/README.md) for hosted migration and grants.

The [database design index](../../../Docs/lld/01-database/README.md) describes the intended model, invariants, and acceptance plan. The independent suppression authority uses its own database and verification path. See [authority implementation](../src/security/suppression-authority.ts) and [authority test fixture](../../../tests/fixtures/suppression-ledger-bootstrap.sql).
