# ADR-013: Express with TypeScript for the API

**Status:** Approved — explicit owner-confirmed framework decision; implementation verification pending
**Date:** 2026-11-15  
**Decision owner / reviewer:** Product Owner (explicit backend change request); engineering implementation verification remains pending  
**Supersedes:** HLD ADR-002 and the API framework selection in ADR-001  
**Related documents:** [HLD](../HLD.md), [SRS](../../requirements/SRS.md), [database LLD](../../lld/01-database/logical-design.md)

## Context and constraints

Founder's Lens needs an authenticated HTTP API for private idea workspaces, streaming conversations, reviewed memory, evidence, experiments, and PDF approvals/downloads. The earlier HLD selected Fastify with TypeScript. The owner now requests Express with TypeScript; this record treats that as the target stack, including strict TypeScript rather than JavaScript-only Express.

The repository contains design documents only: no API source, package manifest, or lockfile exists to migrate. Separate Next.js web, API, and BullMQ worker deployments, Prisma/PostgreSQL persistence, Clerk identity, and the SRS trust boundaries remain constraints.

## Decision

Use **Node.js + Express 5 + TypeScript with `strict: true`** for the independently deployed API. Express 5 is the major-version baseline; pin exact compatible runtime, SDK, compiler, and type-package versions during implementation. Use a supported Node.js LTS release, matching Express 5 type definitions, and a required CI typecheck before building JavaScript for Node.js execution.

Compose Express routers and thin controllers around application/domain services. Keep HTTP request/response objects in adapters. Use shared versioned Zod schemas for runtime request/response and model-output validation, with inferred TypeScript types. Express middleware must explicitly handle authentication, input parsing, ownership enforcement, quotas, correlation/logging, and errors; none of those business guarantees follows from adopting TypeScript.

Use `@clerk/express` to establish verified authentication context, then explicitly protect private routes and check account/idea ownership. API failures use structured JSON rather than a sign-in-page redirect. Stream adapters must handle backpressure, disconnects, deadlines, and failures after headers are sent; only durable final state permits a completion event. Detailed middleware order and event schemas are LLD deliverables.

## Alternatives and consequences

| Alternative | Disposition |
|---|---|
| Keep Fastify + TypeScript | Superseded by the owner's explicit framework choice |
| Express with JavaScript only | Does not satisfy the requested TypeScript target |
| NestJS | Adds a framework and conventions the owner did not request |

Express requires explicit middleware composition and runtime schema enforcement in place of the previous framework assumptions. The team owns registration order, validation/error consistency, OpenAPI integration, and stream lifecycle tests. No performance improvement is claimed; benchmark the selected stack against the SRS profile. This change introduces no product-scope or logical-schema change and makes no new hosting-cost commitment.

## Security, data, and observability effects

Authentication and ownership must run before any provider call or private operation. Preserve per-idea context isolation, idempotency, stale-write checks, reviewed memory, verified evidence references, and exact approved-snapshot PDF exports. Keep database transactions outside provider/network work. Preserve redacted structured logs, correlation IDs, attempt/job IDs, and completion/failure metrics. Framework changes do not justify logging private prompts or tokens.

## Verification and rollout

This is a documentation-stage decision; there is no deployed framework migration or data migration to execute. Before implementation sign-off:

1. Pin compatible packages and prove strict typecheck/build/start for the API and workers.
2. Prove the Clerk browser-to-API flow, missing/expired/invalid-token rejection, allowed-origin CORS including preflight/error responses, and cross-user/idea denial.
3. Verify malformed/oversized requests and unknown model-card variants fail safely, and rejected async handlers produce the documented error envelope.
4. Exercise streaming success, backpressure, stop/disconnect, provider failure after headers, and process shutdown; reconcile authoritative state without duplicate messages or false completion.
5. Run the existing SRS acceptance suites for idempotency, memory approval/concurrency, evidence provenance, worker replay, and approved PDF parity.

These are planned checks, not claimed test results. Existing SRS acceptance criteria remain authoritative.

**SRS traceability:** `INV-001`–`INV-014`; `FR-008`–`FR-012`, `FR-019`, `FR-023`, `FR-028`, `FR-038`, `FR-043`–`FR-047`; `NFR-001`, `NFR-003`–`NFR-005`, `NFR-013`, `NFR-017`–`NFR-018`.

**Revisit trigger:** measured SRS performance failures, middleware/security maintenance problems, or incompatible identity/streaming SDK behavior that cannot be resolved within this architecture. A future change requires a superseding ADR and evidence; update the SRS only if observable behavior changes.

## Primary references

- [Express 5 migration guide](https://expressjs.com/en/guide/migrating-5/)
- [Express error handling](https://expressjs.com/en/guide/error-handling/)
- [Clerk Express middleware](https://clerk.com/docs/reference/express/clerk-middleware)
- [TypeScript strict mode](https://www.typescriptlang.org/tsconfig/strict.html)
- [TypeScript noEmitOnError](https://www.typescriptlang.org/tsconfig/noEmitOnError.html)
