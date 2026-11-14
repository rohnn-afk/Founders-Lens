# Founders-Lens
An AI-powered thinking partner helping entrepreneurs challenge assumptions, explore real-world evidence, and turn business ideas into actionable experiments.

The product name is **Founder's Lens**; “Thinking Partner” describes its positioning. The MVP is a private, authenticated workspace for conversations, reviewed idea memory, bounded evidence research, experiments and reflection, and reviewed Idea Snapshot PDF exports.

The repository currently contains product and architecture documentation. Application code, dependencies, and build scripts have not been added yet.

The selected stack is Next.js with TypeScript for the web, a separately deployed **Node.js + Express 5 + strict TypeScript** API, PostgreSQL with Prisma, Clerk authentication, and independent TypeScript workers using BullMQ + Redis. Shared Zod schemas provide runtime validation alongside TypeScript types.

Product and engineering documents:

- [PRD](Docs/PRD.md): product intent, audience, journeys, and initial scope proposals.
- [SRS](Docs/SRS.md): MVP behavior, confirmed product decisions, invariants, and acceptance criteria; supersedes conflicting PRD proposals.
- [HLD](Docs/HLD.md): architecture, deployment boundaries, trust, and failure handling.
- [Database LLD](Docs/LLD/Phase-A-DB-design/database-logical-design.md): logical entities, transactions, and integrity rules.
- [ADR-013: Express with TypeScript](Docs/ADR/013-express-typescript-api.md): the backend decision confirmed on 2026-11-15, superseding the earlier Fastify choice.
