# Express API

[Main](src/main.ts) selects a runtime composition. [App setup](src/app.ts) installs health routes, request context, security middleware, and the optional `/api/v1` workspace router.

| Module | Responsibility and entry point |
| --- | --- |
| Workspace | Ideas, conversations, transcripts, and environment-specific route mounting. Start with [routes](src/workspace/routes.ts), [staging composition](src/workspace/staging-composition.ts), or [local composition](src/workspace/read-only-composition.ts). |
| Submission | Message admission, idempotency, and persistence. Start with [routes](src/submission/routes.ts), [contracts](src/submission/contracts.ts), and [service](src/submission/service.ts). |
| Generation | Generation status, local execution policy, and other operations where mounted. Start with [routes](src/generation/routes.ts), [contracts](src/generation/contracts.ts), and [execution scope](src/generation/execution-scope.ts). |
| Security | Clerk session verification, principal resolution, authorization, and suppression checks. Start with [Clerk adapter](src/security/clerk.ts), [identity service](src/security/identity-service.ts), [authorization](src/security/authorization.ts), and [suppression authority](src/security/suppression-authority.ts). |
| Privacy | Deletion admission and recovery, plus verification of runtime recovery clearance. Start with [admission](src/privacy/deletion-admission.ts), [recovery](src/privacy/deletion-recovery.ts), and [clearance](src/privacy/runtime-recovery-clearance.ts). |
| Persistence | Database client and transaction boundaries. Start with [client](src/persistence/client.ts), [workspace transactions](src/persistence/workspace-transaction.ts), and the [database guide](prisma/README.md). |

Run `npm run dev:api` from the root. Check composition before changing an endpoint. The [staging read contract](WORKSPACE-API.md) describes the hosted GET surface. Local and isolated test compositions can expose additional operations. The [API security design](../../Docs/lld/02-api-security/architecture-and-security.md) explains the intended trust boundaries.
