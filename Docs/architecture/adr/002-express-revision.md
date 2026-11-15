# ADR-002 Revision — Express + TypeScript Backend

**Status:** Superseded as a standalone specification; preserved historical record of the accepted owner direction (2026-11-15). Canonical record: [ADR-013](013-express-typescript-api.md).  
**Supersedes:** HLD ADR-002 selection of Fastify.  
**Scope:** HTTP API framework only; no change to architecture topology or product requirements.

## Context
Founder's Lens uses a separate Node.js/TypeScript backend, PostgreSQL with Prisma, Clerk identity, Redis/BullMQ workers and a modular-monolith domain design. The owner explicitly selected Express + TypeScript in place of Fastify.

## Decision
Use **Express 5 + strict TypeScript** for the HTTP API. Adopt Zod for request validation, `@clerk/express` for authentication, explicit dependency injection, central error mapping and structured telemetry. Do not put Express types into domain/core business logic.

## Consequences
- **Benefits:** Familiar and broadly supported ecosystem; clear controller/use-case separation under our control; straightforward onboarding and documentation.
- **Costs:** Must deliberately assemble validation, schemas, security hardening and request lifecycle conventions; cannot rely on Fastify-native validation/plugin lifecycle behaviors.
- **Unchanged:** Separate Next.js, independently deployable API/worker, PostgreSQL source of truth, domain ownership, request idempotency, transactional outbox, privacy and streaming semantics.
- **Migration of documents:** Replace Fastify references in HLD architectural views, ADR register, interface descriptions and LLD handoff. Preserve an audit trail that the design originally selected Fastify.

## Verification
Express/Clerk integration spike, auth and object authorization tests, validation/error mapping test, SSE reconnect test, multi-instance rate limit test, graceful shutdown test.


This abbreviated record overlaps ADR-013 but is retained because it contains distinct rationale and verification history. It introduces no second framework decision.
