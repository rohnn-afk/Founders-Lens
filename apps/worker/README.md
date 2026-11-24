# Worker

The worker consumes BullMQ generation jobs, claims execution, loads permitted context, and persists the assistant result and provider accounting.

- [Consumer](src/generation-consumer.ts) receives jobs. [Generation worker](src/generation-worker.ts) coordinates the job lifecycle.
- [Context builder](src/generation-context.ts) and [leased context reader](src/leased-context-reader.ts) prepare inputs under the execution lease.
- [Provider interface and adapter](src/founder-provider.ts), [Groq adapter](src/groq-provider.ts), and [accounting](src/provider-accounting.ts) cover provider execution and usage.
- [Generation repository](src/generation-repository.ts) implements claim and persistence operations.
- [Main](src/main.ts) is the lifecycle shell called by `npm run dev:worker`. The [P9 launcher](../../scripts/p9-local-runtime.mjs) wires the active local worker.

Use the [P9 runbook](../../Docs/runbooks/p9-local-runtime.md) for deterministic and provider modes. Start verification with the [worker suite](../../tests/m05-generation-worker.test.mjs), [context suite](../../tests/m06-generation-context.test.mjs), or [PostgreSQL/Redis suite](../../tests/m05-generation-postgres-redis.test.mjs).
