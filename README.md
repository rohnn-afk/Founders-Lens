# Founders-Lens
An AI-powered thinking partner helping entrepreneurs challenge assumptions, explore real-world evidence, and turn business ideas into actionable experiments.

The product name is **Founder's Lens**; “Thinking Partner” describes its positioning. The MVP is a private, authenticated workspace for conversations, reviewed idea memory, bounded evidence research, experiments and reflection, and reviewed Idea Snapshot PDF exports.

The repository contains the web app, Express API, dispatcher, worker, Prisma migrations, and automated tests. The local P9 acceptance run verified a signed-in founder submission through Groq, a persisted assistant answer, and settlement of 804 provider-reported tokens. This is a local engineering baseline. The public MVP and hosted deployment are still in progress.

For local AI runtime configuration and permission boundaries, see [P9 local runtime](scripts/p9-local-runtime.md). The [implementation roadmap](Docs/lld/09-implementation-strategy/implementation-readiness-integration-review.md#local-implementation-acceptance--2026-11-26) records local acceptance and remaining product gates. Run `npm run lint`, `npm run typecheck`, and `npm test` with the pinned toolchain to validate the workspace.

The selected stack is Next.js with TypeScript for the web, a separately deployed **Node.js + Express 5 + strict TypeScript** API, PostgreSQL with Prisma, Clerk authentication, and independent TypeScript workers using BullMQ + Redis. Shared Zod schemas provide runtime validation alongside TypeScript types.

Start with the [documentation index](Docs/README.md) for canonical specifications, approval status, validation evidence and open blockers.

Product and engineering documents:

- [PRD](Docs/requirements/PRD.md): product intent, audience, journeys, and initial scope proposals.
- [SRS](Docs/requirements/SRS.md): MVP behavior, confirmed product decisions, invariants, and acceptance criteria; supersedes conflicting PRD proposals.
- [HLD](Docs/architecture/HLD.md): architecture, deployment boundaries, trust, and failure handling.
- [Database LLD](Docs/lld/01-database/logical-design.md): logical entities, transactions, and integrity rules.
- [ADR-013: Express with TypeScript](Docs/architecture/adr/013-express-typescript-api.md): the backend decision confirmed on 2026-11-15, superseding the earlier Fastify choice.

## API reference

Start the API with `npm run dev:api`. Swagger UI is at [http://127.0.0.1:3001/docs](http://127.0.0.1:3001/docs), and the OpenAPI 3.1 document is at [http://127.0.0.1:3001/openapi.json](http://127.0.0.1:3001/openapi.json). The default local shell shows health routes. A workspace runtime adds its admitted operations at startup.

See the [API authentication guide](apps/api/API-AUTHENTICATION.md) for the signed-in developer workflow and documentation modes. See [Deployment](DEPLOYMENT.md) for the staging URLs and release gates.
