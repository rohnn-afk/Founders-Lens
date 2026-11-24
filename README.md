# Founder's Lens

Founder's Lens is an AI thinking partner for entrepreneurs to challenge assumptions, examine evidence, and turn ideas into experiments.

## Start here

1. Read the [project map](Docs/guides/README.md) for current capabilities, the request flow, and the source of truth for each area.
2. Use the [local development guide](Docs/guides/local-development.md) to start the web app and API and run checks.
3. Open the module guide closest to what you want to change.

| Module | Guide |
| --- | --- |
| Next.js web app and workspace UI | [Web](apps/web/README.md) |
| Express routes, security, and privacy | [API](apps/api/README.md) |
| PostgreSQL schema and migrations | [Database](apps/api/prisma/README.md) |
| PostgreSQL outbox to BullMQ | [Dispatcher](apps/dispatcher/README.md) |
| Generation jobs and provider adapters | [Worker](apps/worker/README.md) |
| Automated verification | [Tests](tests/README.md) |

[Operator runbooks](Docs/runbooks/README.md) cover staging and local generation. The [engineering design register](Docs/README.md) indexes requirements, approved specifications, and their review history.

Develop in the primary checkout on `integration/consolidated`. Use `staging` for deployment. See the [repository instructions](AGENTS.md) and [release procedure](DEPLOYMENT.md).
