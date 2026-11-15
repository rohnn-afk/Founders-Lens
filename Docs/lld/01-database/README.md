# Database specifications

**Status:** In Review — documentation only; approval and execution evidence tracked separately

- [Logical design](logical-design.md): domain entities, ownership and business consistency.
- [Physical design](physical-design.md): proposed columns, transactions, indexes and mapping.
- [Prisma schema](schema/schema.prisma): proposed 23-model schema; documentation artifact.
- [SQL guards](constraints/guards.sql): append after generated table/type/FK DDL; not a standalone initial migration.
- [Integration tests](validation/integration-test-plan.md): PostgreSQL acceptance plan, not test results.

Do not copy these into a second competing documentation tree. Future implementation must generate reviewed migrations and prove constraints on PostgreSQL. Open issues and cross-layer invariants are in the [integration register](../04-integration-review/discrepancy-register.md).
