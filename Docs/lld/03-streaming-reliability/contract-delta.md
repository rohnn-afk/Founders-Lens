<!-- Historical phase handoff; see Phase 2D register for current resolution status. -->

# 4. Phase 2B/1B reconciliation and design review gates

## Phase 2B OpenAPI (draft → Phase 2C design contract)

| Contract item | Required change | Ownership / gate |
|---|---|---|
| `POST /messages` 202 | Use stable operation reference body `{messageId,generationId,status,statusUrl,eventsUrl}`; same-key replay semantics, Location header | API Phase 2B amendment |
| `GET /generations/{id}` | Detailed terminal and active status enum; selected/output ID; sanitized error; generation timestamps | Conversation LLD Phase 3 |
| `GET /generations/{id}/events` | Specify `text/event-stream`, event grammar in streaming doc, heartbeat and unsupported Last-Event-ID 400, 406 Accept check, authenticated fetch, no IDs/replay | Phase 2C accepted design |
| `POST /generations/{id}/cancel` | Require idempotency key; 202 CANCEL_REQUESTED vs 200 terminal; doc cancellation race | API + state contract |
| `POST /regenerations` | Latest turn only; distinct attempt; 202 + key + quota; failed attempt never replaces previous selected answer | API + conversation |
| All API errors | Stable error envelope; add `REQUEST_IN_PROGRESS`, `GENERATION_IN_PROGRESS`, `IDEMPOTENCY_KEY_REUSED`, `CANCEL_NOT_ALLOWED`, `STREAM_UNAVAILABLE` codes; 429 Retry-After, 503 | API Phase 2B amendment |
| Auth/proxy | Explicit session Bearer on every GET stream/status and CORS; no URL bearer, no caching of private stream | Security Phase 2A integration |
| OpenAPI tool validation | YAML + local refs + unique operationIds + spectral/lint + scenario contract tests | Implementation CI |

**Deliberate non-change:** No web socket or `/events/replay` endpoint in v1. The status and transcript endpoints satisfy reconnection without token history.

## Phase 1B PostgreSQL/Prisma deltas (not migrated yet)

1. Add `IdempotencyRecord` **as proposed new entity**, so logical table inventory increases from 20 to **21**. Define scoped unique key; payload fingerprint and version; response reference; in-progress/terminal state; TTL. Ensure failure outcome replay semantics align to each operation.
2. Add `GenerationAttempt.leaseEpoch`, `leaseUntil`, `lastHeartbeatAt`, `deadlineAt` and cancellation acknowledgment fields, with conditional atomic state transitions. No field or SQL is claimed implemented yet.
3. Extend the active-generation partial unique predicate to include `CANCEL_REQUESTED` (or equivalent long-lived active lock) so a cancel-requested attempt cannot overlap a new generation.
4. Confirm uniqueness of one response message per attempt and at most one selected COMPLETED attempt per original user message; add DB-guarded selection transitions where feasible.
5. Align `Message.clientSubmissionKey` with public DTO name `clientSubmissionId` and add durable hash and scoped uniqueness; maintain compatibility mapping in repositories, not by trusting client role/sequence.
6. Budget/usage ledger needs reservation/settlement IDs, version-safe quota enforcement, reconciliation for orphaned reservations, and provider cost duplication caveat.
7. Outbox fields should support claim/retry/lease ownership; dispatcher idempotency, stuck-claim timeout and safe terminal tracking.
8. Finalized account deletion approach must support erasing append-only memory revisions, generation history and private document blobs with privileged audited purge mechanism, while retaining minimal lawful operational metadata only under an explicit policy.
9. Select desired assistant attempt only when response is committed and verified; ensure transcript and AI context builder use selection predicate.
10. Resolve canonical message sequence behavior during regeneration: recommendation is a logical turn projection anchored to trigger user sequence; physical later assistant message gets a fresh server sequence, not inserted/reordered. Cursor stability and transcript ordering need explicit query tests.

## Phase 2A security checks

- Verify Clerk session-token type, issuer/authorized-party settings and expiration using current SDK; account/idea access checks each stream attachment and terminal fetch; handle revocation and deletion during **long-lived** streams (periodic reauthorization or close on account lifecycle event; upper-bound stream lifetime).
- CORS preflight and trusted-proxy configuration; no URL tokens, no reflected origins, no websocket upgrade dependency, no logging of stream text.
- Deny malicious cross-tenant generation IDs even when another tenant's Redis topic is known; no direct client broker access.

## Phase 3 Conversation LLD dependency

The conversation engine must accept the Phase 2C durable state machine and decide model prompt context ordering, grounding, final response schema validation, emission policy for cards, how worker feedback produces memory proposals, token budgets and selected regenerate response. Phase 2C does not design AI reasoning strategy itself.

## Decision checklist

| Area | Proposed decision | Review state |
|---|---|---|
| Continue on SSE disconnect | Yes | Proposed |
| V1 SSE token replay | No | Proposed |
| Pub/Sub vs durable queue | BullMQ for work, ephemeral pub/sub for live updates | Proposed |
| Cancel completed response | No | Proposed |
| Cancel wins after DB CAS | No late completion | Proposed |
| Regenerate latest only | Yes | Proposed |
| Generic idempotency ledger | Yes | Phase 1B amendment required |
| Worker epoch fencing and deadline | Yes | Phase 1B amendment required |
| Quota reservation correctness | PostgreSQL | Phase 1B amendment required |
| 24/7 deployment free/no-card | Unresolved; not a logical/API design assumption | Operational gate |


## Phase 2D disposition

Browser disconnect continuation and no durable token replay are accepted owner decisions. Other recommendations remain proposed unless explicitly approved. Draft OpenAPI corrections are applied; physical Phase 1B now exists as an unvalidated draft. See [register](../04-integration-review/discrepancy-register.md) for remaining blockers; this historical checklist is not the current approval ledger.
