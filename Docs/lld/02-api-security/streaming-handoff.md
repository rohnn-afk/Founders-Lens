<!-- Historical phase handoff; see Phase 2D register for current resolution status. -->

# Phase 2C Handoff — Streaming, Retries and Idempotency

## Design decisions to freeze next

1. Whether AI generation continues after an SSE disconnect; how reattachment behaves on expired sessions and deleted ideas.
2. Exact SSE event types, required fields, event IDs, heartbeats, payload byte limits, `Last-Event-ID` policy, and whether token deltas are replayable. V1 recommended: no replay guarantee; durable status/transcript re-fetch.
3. Message/generation persistence ordering, per-conversation active lock, client submission ID versus Idempotency-Key canonicalization, partial/final answer selection.
4. Timed-out HTTP accepted-but-response-lost outcome; exact replay status and response headers for duplicate requests.
5. Cancellation races, regeneration of latest eligible turn, late model completions and process shutdown reconciliation.
6. Redis rate-limiter/queue failure modes; provider budget reservation, quotas and refund/settlement.
7. Transactional outbox failure/replay, dedupe window, reclaim of stuck dispatch and worker fencing.

## Non-negotiable cross-phase dependencies

- Reconcile generic idempotency ledger and optimistic version fields with physical Phase 1B schema.
- Resolve streaming DTO/schema and assistant attempt display semantics with Conversation LLD (Phase 3).
- Explicitly authorize stream/download resumption after token expiry and user/idea deletion transitions.
- Only claim at-least-once job processing with idempotent effects; never exactly-once delivery.

## Deliverables

`streaming-and-retry-design.md`, `sse-event-spec.md`, `idempotency-lifecycle.md`, `generation-state-machine.md`, `phase-2c-contract-tests.md` and corresponding OpenAPI updates.


## Phase 2D disposition

Browser disconnect continuation and no durable token replay are accepted owner decisions. Other recommendations remain proposed unless explicitly approved. Draft OpenAPI corrections are applied; physical Phase 1B now exists as an unvalidated draft. See [register](../04-integration-review/discrepancy-register.md) for remaining blockers; this historical checklist is not the current approval ledger.
