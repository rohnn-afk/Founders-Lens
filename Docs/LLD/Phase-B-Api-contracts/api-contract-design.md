# Founder's Lens — LLD Phase 2B: API Contract Design

**Version:** 0.2 (design review)  
**Status:** Proposed; no application implementation or running server validation  
**Baseline:** Approved PRD/SRS/HLD with Express ADR; Phase 1A logical model; Phase 1B provisional PostgreSQL schema; Phase 2A Express + Clerk security design.  
**Companion artifacts:** `openapi.draft.yaml`, `route-inventory.json`, `error-and-test-matrix.md`, `phase-2c-handoff.md`.

## 1. What an API contract is

An API contract is an enforceable promise between the frontend, Express backend, and dependent systems about **what is sent, what is returned, what permissions are required, and what happens when something fails**. It is not a list of route names, and it does not replace application or data consistency rules. The OpenAPI file is intended to be the machine-readable source of truth once reviewed.

**Design goals:** secure founder-isolated REST operations; stable JSON shapes; selective asynchronous processing; concurrency-safe state transitions; server-owned identities; predictable failures; documentation that can drive contract tests and Codex implementation. **Non-goals:** implementation, live Prisma migration validation, SSE event grammar, full research/AI orchestration algorithms, deployment-specific quotas.

## 2. Contract-wide decisions

| ID | Decision | Engineering reasoning |
|---|---|---|
| API-01 | HTTPS, JSON REST `/api/v1` | Explicit versioning and consistent transport. Versions signal breaking *external* contract changes, not code releases. |
| API-02 | Clerk session bearer token on all founder routes | Identity only. Our API checks active local user and idea ownership. Never accept client-supplied `ownerId`. |
| API-03 | UUID resource IDs and ownership-scoped repository lookups | Opaque IDs are not authorization. Foreign resource and missing resource both return 404. |
| API-04 | Zod strict parsing of params/query/body and explicitly projected DTOs | Extra client fields never mutate DB by accident. Never return Prisma records wholesale. |
| API-05 | `400 VALIDATION_ERROR` for schema/semantic request format errors | Single predictable error code; reserve 409 for current-state conflicts and 412 for stale versions. |
| API-06 | Strong version ETag `"vN"` for mutable resources and required `If-Match` on listed mutation routes | Optimistic concurrency; 412 on stale version. Versioned operations require an atomic compare-and-update. |
| API-07 | `Idempotency-Key` on selected non-idempotent actions | Durable scoped fingerprint; key reuse with different payload returns 409. Timeout after commit can be safely replayed. |
| API-08 | `202 Accepted` plus durable job/generation resource for long work | No database transaction while waiting for LLM, internet or PDF. A 202 means accepted, not finished. |
| API-09 | Cursor pagination (`limit` 1–100, default 25) and stable sort | Efficient transcripts and list queries, avoids offset drift. Opaque cursor binds sorting/filter scope. |
| API-10 | Error envelope `{error:{code,message,requestId,retryable,details?}}` | Stable safe UI behavior and observability; no internal traces, URLs, or private founder content. |
| API-11 | SSE at `GET /generations/:id/events` over authenticated fetch | Native EventSource cannot set Bearer auth header; Phase 2C freezes grammar and reconnect rules. |
| API-12 | No direct public worker, outbox, usage-ledger or arbitrary evidence-trust setters | Preserve domain ownership and prevent abuse. |

### Request processing standard

1. TLS/proxy, correlation ID, safe logging, CORS/security headers and bounded request size.
2. Clerk session verification and local account eligibility.
3. Distributed per-identity/IP rate limits and cost reservation for expensive operations.
4. Strict Zod validation of path, query, headers and body.
5. Resolve authorized idea/resource through owner-scoped database query and check lifecycle/version.
6. Use-case transaction for short state changes; create durable outbox entry for jobs.
7. Return explicit DTO, status and ETag where applicable. Never return raw private data in error or log.

### Header policy

- `Authorization: Bearer <Clerk session token>` on all protected routes. Frontend token acquisition and authorized-party configuration must be proven with SDK integration tests.
- `Content-Type: application/json` for JSON request bodies; reject others with 415. Cap body and field lengths; no raw arbitrary HTML input.
- `Idempotency-Key` is *required* for selected POST/DELETE mutations (see inventory). This is a client-created opaque token, not a substitute for auth.
- `If-Match: "vN"` on versioned edits, approvals and decisions (see inventory); missing precondition should be **428 PRECONDITION_REQUIRED** (added to final contract before freeze); stale version returns 412.
- `X-Request-Id` is server-generated or sanitized only from trusted infrastructure and echoed for diagnostics; `traceparent` is optional and treated as untrusted input.
- `Cache-Control: no-store` on private data, streams, and download grants. ETags are concurrency controls, not permission to cache private data publicly.
- Never put bearer credentials in URL parameters, stored queue payloads, or exported document links.

### Success status taxonomy

- `200`: normal reads/updates/decisions; `201`: synchronously created resource (consider `Location` header).
- `202`: asynchronous operation accepted and represented by durable status object.
- `204`: successful deletion of a *link* or signed webhook acceptance (not a promise of data deletion).
- `401`: no valid session; `403`: known action prohibited on an already accessible object; `404`: missing or foreign private object.
- `409`: conflicting active generation, invalid state transition or idempotency-key hash mismatch.
- `412`: stale `If-Match`; `428`: missing required `If-Match`; `429`: rate/quota exceeded; `503`: transient infrastructure/provider unavailable.
- `413`: oversized payload; `415`: wrong content-type; `500`: unexpected internal fault.

## 3. Domain endpoint inventory

**Detailed path/method/schema inventory is in `route-inventory.json`; machine-readable operations are in `openapi.draft.yaml`.** The inventory totals 48 protected operations plus two operational probes and a Clerk webhook. Routes belong to the authenticated founder only unless specifically stated otherwise.

### Identity & privacy

`GET /me`, `PATCH /me/preferences`, `POST /me/data-operations`, `GET /me/data-operations/{operationId}`.

No frontend-authoritative ownership field. Data-operation requests create a durable workflow; account deletion must disable new sessions/work, cancel jobs and apply a reviewed retention/erasure policy. Sensitive deletion should require a fresh-auth/step-up policy (not yet frozen). Deletion/retention remain a cross-phase gate.

### Ideas & conversations

`GET|POST /ideas`, `GET|PATCH|DELETE /ideas/{ideaId}`; `GET|POST /ideas/{ideaId}/conversations`, `GET|PATCH /conversations/{conversationId}`, `GET /conversations/{conversationId}/messages`, `POST /conversations/{conversationId}/messages`.

Submitted chat messages carry `clientSubmissionId` and `Idempotency-Key`. They must resolve to one logical user message under retries. A successful initial request returns `202` with durable message+generation references; competing active generations receive `409`. The server allocates message ordering. No client-supplied assistant role or message sequence.

### AI generation

`GET /generations/{generationId}`, `GET /generations/{generationId}/events`, `POST /generations/{generationId}/cancel`, `POST /conversations/{conversationId}/regenerations`.

Only the latest eligible user turn may regenerate in v1; attempts remain historical, and one completed attempt is selected. Cancellation is best-effort and never retroactively deletes committed work. The Phase 2C design must decide whether stream disconnect continues or interrupts generation, event framing, heartbeat, final-state semantics and reconnection strategy.

### Memory and corrections

`GET /ideas/{ideaId}/memory`, `GET /ideas/{ideaId}/memory-proposals`, `PATCH /memory-proposals/{proposalId}`, `POST /memory-proposals/{proposalId}/accept`, `POST /memory-proposals/{proposalId}/dismiss`, `PATCH /memory/{memoryId}`, `GET /memory/{memoryId}/revisions`.

No AI output is confirmed without an authenticated user decision. Accepting a proposal atomically changes proposal state and confirmed memory/revision. `If-Match` protects proposal/approved-memory version. A proposed correction is not silently accepted by changing the JSON response. Multiple parallel approvals must result in one accepted durable outcome.

### Assumptions, experiments, reflections

`GET|POST /ideas/{ideaId}/assumptions`, `PATCH /assumptions/{assumptionId}`, `GET|POST /ideas/{ideaId}/experiments`, `PATCH /experiments/{experimentId}`, `POST /experiments/{experimentId}/learnings`, `GET /ideas/{ideaId}/learnings`.

Assumption/experiment references must belong to exactly the same idea. Experiments remain user-owned actions. A learning can reference an experiment but may also be an independent observation via future endpoint extension. Do not convert an experiment outcome automatically to a verified general market fact.

### Research and evidence

`GET /ideas/{ideaId}/evidence`, `GET|POST /ideas/{ideaId}/research-jobs`, `GET /research-jobs/{researchJobId}`, `POST /assumptions/{assumptionId}/evidence-links`, `DELETE /assumptions/{assumptionId}/evidence-links/{evidenceId}`.

Research is queued asynchronously and quota-gated; search-provider metadata is server-owned. External citations are provenance, not proof. Clients cannot directly set a finding to `SOURCE_CHECKED`. Idea ID consistency applies to every evidence link. Auto-research can also originate internally from a generation; do not expose an unbounded generic web-fetch endpoint.

### Snapshot and PDF exports

`GET|POST /ideas/{ideaId}/snapshots`, `GET|PATCH /snapshots/{snapshotId}`, `POST /snapshots/{snapshotId}/approve`, `POST /snapshots/{snapshotId}/exports`, `GET /exports/{exportId}`, `POST /exports/{exportId}/download-grant`.

Only draft snapshot content may mutate. `POST approve` requires explicit confirmation and version precondition. Approved content is frozen, versioned and hashed. Export is an async job referencing an approved immutable snapshot; any download grant is owner-checked, short-lived and never stored in persistent logs.

### Operational

`GET /health/live` is public and process-only. `GET /health/ready` must be ingress-restricted or share only minimal status. `POST /webhooks/clerk` must verify raw-body signature, timestamp and replay before any processing; route does **not** accept normal end-user Bearer auth as a substitute.

## 4. Pagination and sorting decisions

For ideas/conversations order by `(updatedAt DESC, id DESC)`; for messages by `(sequence ASC, id ASC)`; for events/history by creation/revision plus ID tie-breaker. Cursor is signed or authenticated against query dimensions and owner scope; invalid scope/cursor returns 400. Maintain a stable filtering/sorting contract; enforce `limit<=100` and maximum aggregate response budget. An empty list returns `items: []` and `hasMore: false`, never an authorization error when the parent is owned.

For pagination across mutable lists, document that newly inserted or updated rows can appear in later navigation; do not advertise a snapshot-isolated infinite-scroll experience without a snapshot cursor.

## 5. Idempotency contract (preliminary — Phase 2C owns final lifecycle)

A scoped key identifies `(localUserId, operationName, authorized target scope, key)` plus a canonical JSON hash of request body and relevant semantic headers. Repeated same key + same input returns the same logical operation reference and latest known status; same key + different input returns 409. Concurrent same-key calls require a DB uniqueness claim or transaction-safe equivalent. Terminal error/retention choices must be specified per operation. **Phase 1B has no fully settled generic idempotency persistence design for every operation; this is a blocking schema reconciliation issue** before implementing all routes.

Do not retry AI/provider calls simply because the HTTP response was lost. Background jobs may run at least once; external side effects require dedupe and late-result fencing. Cancellation is never a guarantee that providers did no work.

## 6. Version and ETag contract

Server emits a strong ETag `"v<integer>"` for mutable resources. Client sends `If-Match` on PATCH and selected state-change POSTs. The service compares versions atomically, increments on success, returns latest projection/ETag. Stale/failed predicate returns 412. A missing required precondition returns 428 (not 400). Non-versioned append-only actions instead use idempotency and input consistency checks.

The **provisional database schema must be reconciled** because not every proposed endpoint currently has corresponding version columns, generic replay records, or revision retention rules. Do not assume an ETag header alone prevents races.

## 7. Privacy, rate controls and caching

- Every nested ID lookup is constrained through the authenticated owner's idea, not a bare UUID.
- All list and detail responses use explicit projections; prompt text, provider secrets, internal metadata and other founders' IDs never leak.
- Per-user and per-IP distributed limits; stricter caps and durable quota reservation for AI/research/PDF. Fail closed for cost-incurring work when limiter/quotas cannot be verified.
- Private JSON is `Cache-Control: no-store`; cookies vs bearer behavior and CORS origins must be tested under real Clerk environments.
- External URLs (research citations) are inert strings in response; server fetching requires separate SSRF controls in Phase 5.

## 8. Example contracts

### Create an idea

`POST /api/v1/ideas`, valid Clerk Bearer token, `Idempotency-Key: <opaque>`, JSON `{"title":"Healthy tiffin service","summary":"Bengaluru working professionals"}` → `201` plus `Idea` DTO and `Location`. An arbitrary `ownerId` in body fails strict validation. A retry with the same idempotency key and body returns the original idea reference.

### Send a message

`POST /api/v1/conversations/{conversationId}/messages`, `Idempotency-Key`, JSON `{"clientSubmissionId":"<uuid>","content":"Will people pay for this?"}` → `202` `{"message":{...},"generation":{...}}`. After this, `GET /generations/{generationId}` yields durable status. `GET /generations/{generationId}/events` streams while generation is active, subject to Phase 2C rules.

### Approve memory proposal

`POST /api/v1/memory-proposals/{proposalId}/accept`, `If-Match: "v3"`, `Idempotency-Key`, optional JSON `{"approvedText":"Target is Bengaluru professionals"}` → `200` confirmed-memory DTO. Concurrent stale approval returns `412`. This requires proposal versioning in the database, not only revision history for the resulting memory.

### Create research request

`POST /api/v1/ideas/{ideaId}/research-jobs`, `Idempotency-Key`, `{"question":"What substitutes do customers use?","geography":"Bengaluru"}` → `202` `ResearchJob`; later evidence retrieval is separately authenticated and provenance-rich.

## 9. Schema/contract reconciliation blockers

1. **Generic idempotency table:** The Phase 1B model includes a submission ID for chat and some dedupe fields for jobs, but not a universal replay ledger for all newly required `Idempotency-Key` routes. Either add that ledger with bounded retention and expiry or scope required keys to operations actually supported by DB uniqueness. Recommendation: add ledger.
2. **Version fields:** `MemoryProposal` and some draft/document operations require version columns or other atomic preconditions matching this spec. Reconcile physical Prisma and SQL guards before implementation.
3. **Actual DTO property names:** Several proposed fields (`finding`, `reflection`, `method`, `successCriteria`) are semantic shapes rather than certified 1:1 Prisma attribute projections. A DTO adapter is acceptable, but mapping must be explicit and tested.
4. **Response selection after regeneration:** Exactly which assistant message/attempt is selected and how it appears in transcript is Phase 2C/Phase 3 design; don't silently expose duplicates as authoritative.
5. **Account deletion:** Strong-auth confirmation, handling of immutable audit records, storage purge, Clerk synchronization and retention policy require a complete privacy decision.
6. **Research evidence:** Separate provenance of fetched *sources* from derived findings if one source supports several claims or several sources support one claim. Logical model currently treats them largely inside `EvidenceRecord`; Phase 5 must approve this v1 tradeoff.
7. **Snapshot input schema:** Draft `content` is deliberately loose in this contract. It must become a versioned structured `SnapshotContent` discriminated schema before public release to prevent arbitrary/unrenderable HTML or excessive data.
8. **Streaming status:** SSE response schema is a placeholder, not complete; freeze event grammar in 2C.
9. **Webhook details:** Verify concrete Clerk event variants and signature SDK behavior during implementation; do not invent wire-level names here.

## 10. Design review and acceptance

- Every route has a single owner module, auth policy, typed request/response and documented common error contract.
- Cross-owner and cross-idea negative tests exist for all private resource families.
- Long-running operations return durable job refs rather than holding a transaction.
- The OpenAPI YAML parses and has no unresolved local `$ref` pointers; API design approval does not mean running-server conformance.
- All unresolved contract-to-schema mismatches above are tracked for Phase 1B reconciliation before Codex implementation.
- Phase 2C must freeze streaming and idempotency semantics before approving the complete Phase 2 API contract.

**Decision status:** Proposed API contract baseline, ready for user/design review. **Not implementation-approved.**
