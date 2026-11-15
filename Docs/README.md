# Founder's Lens engineering documentation

**Status:** Approved Phase 2D documentation — A07, FL-P2D-1.0-approved; implementation acceptance remains separate

## Authority and review status

Explicit approved product decisions and active ADRs > PRD scope/goals > SRS requirements/acceptance > approved HLD boundaries > LLD detailed design > OpenAPI representation > test specifications. Raise a discrepancy instead of silently overriding a higher-level promise. Express + TypeScript supersedes Fastify. Confirmed stack: Next.js/TypeScript, Node.js/Express/TypeScript, Clerk, Zod, PostgreSQL/Prisma, BullMQ/Redis, REST/SSE; modular monolith with independent frontend/API/workers and Docker-compatible boundaries. AWS is preferred; hosting feasibility/cost not approved.

Statuses: Draft (incomplete proposal), In Review (reviewable design, not signed off), Approved (explicit owner/reviewer/version evidence), Superseded (historical; use linked replacement). The owner describes the prior PRD/SRS/HLD as approved in the current closure request; exact historical revision provenance remains D01. The Phase 2D closure has formal A07 approval; see the approval register and immutable revision manifest. Do not interpret In Review as runtime validation. The five core Phase 2D product decisions are explicitly approved in the decision log; ancillary retention/deployment proposals remain identified separately.

## Canonical specifications

| Responsibility | Canonical source |
|---|---|
| Product goals and scope | [PRD](requirements/PRD.md) |
| Requirements, invariants, acceptance IDs | [SRS](requirements/SRS.md) |
| Architecture and deployment boundaries | [HLD](architecture/HLD.md) |
| Active framework decision | [ADR-013](architecture/adr/013-express-typescript-api.md) |
| Preserved abbreviated decision | [Superseded ADR-002 revision](architecture/adr/002-express-revision.md) |
| Domain model and persistence | [Database index](lld/01-database/README.md), [logical](lld/01-database/logical-design.md), [physical](lld/01-database/physical-design.md) |
| Schema and PostgreSQL guards | [Prisma](lld/01-database/schema/schema.prisma), [SQL](lld/01-database/constraints/guards.sql) |
| Database acceptance plan | [Integration tests](lld/01-database/validation/integration-test-plan.md) |
| API architecture, Clerk and security | [Security design](lld/02-api-security/architecture-and-security.md), [review checklist](lld/02-api-security/review-checklist.md) |
| Public HTTP contract and inventory | [API contracts](lld/02-api-security/api-contracts.md), [OpenAPI](lld/02-api-security/openapi.yaml), [routes](lld/02-api-security/route-inventory.json) |
| API errors and verification | [API testing](lld/02-api-security/testing.md) |
| Streaming grammar and job reliability | [Streaming index](lld/03-streaming-reliability/README.md), [stream contract](lld/03-streaming-reliability/streaming-contract.md), [idempotency/concurrency](lld/03-streaming-reliability/idempotency-and-concurrency.md) |
| Streaming rationale and tests | [Decisions](lld/03-streaming-reliability/fundamentals-and-decisions.md), [tests](lld/03-streaming-reliability/testing.md) |
| Historical cross-phase coordination | [API handoff](lld/02-api-security/streaming-handoff.md), [contract delta](lld/03-streaming-reliability/contract-delta.md) |
| Current integration conclusions | [Integration review](lld/04-integration-review/integration-review.md) |
| Discrepancies and approvals | [Register](lld/04-integration-review/discrepancy-register.md), [decision log](lld/04-integration-review/decision-log.md) |
| Cross-layer mappings and state authority | [Consistency matrix](lld/04-integration-review/consistency-matrix.md), [state machines](lld/04-integration-review/state-machines.md) |
| Requirements and acceptance coverage | [Traceability](lld/04-integration-review/traceability.md), [acceptance matrix](lld/04-integration-review/test-acceptance-matrix.md) |
| Privacy policy and deletion lifecycle | [Policy and lifecycle](lld/04-integration-review/state-machines.md#privacy-and-retention-policy) (approved core policy; other retention settings tracked separately) |
| Clerk durable inbox and tombstones | [Security §16](lld/02-api-security/architecture-and-security.md#16-durable-clerk-webhook-and-identity-tombstone-design) |
| Exact A07 approved revision | [Content manifest FL-P2D-1.0-approved](lld/04-integration-review/approved-revision-1.0.json) |
| Reorganization history and validation | [Cleanup manifest](lld/04-integration-review/cleanup-manifest.md), [validation report](lld/04-integration-review/validation-report.md) |
| Phase 3 readiness and next documentation work | [Handoff](lld/04-integration-review/phase-3-handoff.md) |

## Maintenance rules

Directories use lowercase kebab-case; Markdown uses lowercase kebab-case except README/PRD/SRS/HLD; structured files use conventional names. Keep one owner document per responsibility and link to it. Canonical designs identify purpose, scope/status, requirement/ADR dependencies, invariants, rationale, failure cases, acceptance and open questions; short test/index documents reference governing designs rather than duplicating them. Update incoming links and the index on every relocation. Tests/validation reports distinguish static checks from actual execution. No Kafka, Kubernetes, microservices or additional database is authorized.
