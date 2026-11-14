# Founder's Lens — LLD Phase 2C: Streaming, retries and idempotency

**Status:** Proposed for architecture review (documentation only; no implementation).  
**Baseline:** Approved HLD, Express ADR, Phase 1B provisional data model, Phase 2A security, Phase 2B API contracts.  
**Owner:** Conversation/API design. **Version:** 1.0; 15 November 2026.

## Read in order
1. `fundamentals-and-decisions.md` — teaching guide, scope, explicit ADR-style decisions and tradeoffs.
2. `streaming-and-generation-contract.md` — HTTP/SSE contract, lifecycle, failure handling, diagrams.
3. `idempotency-jobs-and-concurrency.md` — database transactions, retries, cancellations, outbox, fencing, quotas.
4. `test-specification.md` — deterministic and concurrency acceptance matrix.
5. `contract-delta.md` — reconciliation checklist for Phase 2B OpenAPI and Phase 1B schema.

## Approval status
Design choices are **proposed**, not formally signed off. Do not claim database, SDK, load or resilience behavior has been proven. Implementation-stage gates require running Prisma/PostgreSQL migration checks, API contract tests, distributed streaming tests and chaos tests. The API must remain secure and accurate even if SSE is unavailable.

## Invariants
- User message acceptance is durable before 202; 202 never means AI completed.
- Auth and idea ownership are checked for submission, subscription, status, cancel and regenerate independently.
- One active generation per conversation; one selected completed assistant response per user turn.
- User message and selected final assistant message are canonical PostgreSQL data; SSE token fragments are **not** authoritative.
- A repeated network request must never create a second logical chat submission.
- Cancellation is best effort and cannot retract already committed result; a stale worker cannot write a terminal result.
- Jobs execute at least once; business effects are idempotent; no exactly-once provider invocation guarantee.
- Private user content, tokens, source research credentials and raw provider prompts must not appear in logs or queue event broadcasts.
