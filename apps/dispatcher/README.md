# Dispatcher

The dispatcher moves generation work from the PostgreSQL outbox to the BullMQ queue. It checks dispatch clearance, publishes queue jobs, and handles retries and reconciliation.

- [Dispatch coordinator](src/dispatch.ts) manages dispatch and reconciliation.
- [Outbox repository](src/outbox-repository.ts) owns database claims and dispatch state.
- [Queue adapter](src/generation-queue.ts) publishes jobs to Redis.
- [Main](src/main.ts) is the lifecycle shell called by `npm run dev:dispatcher`. The [P9 launcher](../../scripts/p9-local-runtime.mjs) wires the active local dispatcher and worker.

Use the [P9 runbook](../../Docs/runbooks/p9-local-runtime.md) for configuration and the [dispatcher suite](../../tests/m05-dispatcher.test.mjs) and [PostgreSQL/Redis suite](../../tests/m05-dispatcher-postgres-redis.test.mjs) for behavior and integration coverage.
