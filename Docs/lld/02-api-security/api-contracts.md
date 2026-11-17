# Founder's Lens — LLD Phase 2B: API Contract Design

**Version:** 0.5.0 — approved P4-B01/B02 controlled mapping design; Phase4 package FE4D-A08, FL-P4-0.5-approved — Documentation Only
**Status:** Approved — Documentation Only (historical A07; declared Phase 3 amendments P3D-A09, FL-P3-0.3-approved); execution evidence remains pending
**Baseline:** Repository PRD/SRS/HLD with approval provenance tracked in Phase 2D D01; accepted Express ADR; Phase 1A logical model and Phase 2B/2C drafts. Physical Phase 1B and Phase 2A are present in the historical A07 documentation baseline; declared Phase 3 amendments are separately approved under P3D-A09. Runtime validation remains unexecuted.
**Companion artifacts:** [openapi.yaml](openapi.yaml), `route-inventory.json`, [testing.md](testing.md), [streaming handoff](streaming-handoff.md).

## 1. What an API contract is

An API contract is an enforceable promise between the frontend, Express backend, and dependent systems about **what is sent, what is returned, what permissions are required, and what happens when something fails**. It is not a list of route names, and it does not replace application or data consistency rules. OpenAPI is the machine-readable representation of approved human-readable contracts; the Phase 2D source hierarchy governs conflicts.

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

**Detailed inventory is in `route-inventory.json`;machine-readable operations are in `openapi.yaml`.** Current controlled0.4.0 inventory totals50 founder operations plus two probes andthe Clerk webhook (53 total). Historical48/51 counts are the earlier approved baseline. API§19 governs the two new reads andfour negotiated operations;all founder routes remain authenticated/owner-scoped.

### Identity & privacy

`GET /me`, `PATCH /me/preferences`, `POST /me/data-operations`, `GET /me/data-operations/{operationId}`.

No frontend-authoritative ownership field. Data-operation requests create a durable workflow; account deletion must disable new sessions/work, cancel jobs and apply a reviewed retention/erasure policy. Sensitive deletion should require a fresh-auth/step-up policy (not yet frozen). Deletion/retention remain a cross-phase gate.

### Ideas & conversations

`GET|POST /ideas`, `GET|PATCH|DELETE /ideas/{ideaId}`; `GET|POST /ideas/{ideaId}/conversations`, `GET|PATCH /conversations/{conversationId}`, `GET /conversations/{conversationId}/messages`, `POST /conversations/{conversationId}/messages`.

Submitted chat messages carry `clientSubmissionId` and `Idempotency-Key`. They must resolve to one logical user message under retries. A successful initial request returns `202` with durable message+generation references; competing active generations receive `409`. The server allocates message ordering. No client-supplied assistant role or message sequence.

### AI generation

`GET /generations/{generationId}`, `GET /generations/{generationId}/events`, `POST /generations/{generationId}/cancel`, `POST /conversations/{conversationId}/regenerations`.

Only the latest eligible user turn may regenerate in v1; attempts remain historical, and one completed attempt is selected. Cancellation is best-effort and never retroactively deletes committed work. The selected v1 contract continues generation on disconnect; no durable token replay. Phase 2C §2 defines event framing and final retrieval.

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

For ideas/conversations order by `(updatedAt DESC, id DESC)`; for messages by `(trigger user sequence ASC, slot USER then selected ASSISTANT)`; for events/history by creation/revision plus ID tie-breaker. Cursor is signed or authenticated against query dimensions and owner scope; invalid scope/cursor returns 400. Maintain a stable filtering/sorting contract; enforce `limit<=100` and maximum aggregate response budget. An empty list returns `items: []` and `hasMore: false`, never an authorization error when the parent is owned.

For pagination across mutable lists, document that newly inserted or updated rows can appear in later navigation; do not advertise a snapshot-isolated infinite-scroll experience without a snapshot cursor.

## 5. Idempotency contract (preliminary — Phase 2C owns final lifecycle)

A scoped key identifies `(localUserId, operationName, authorized target scope, key)` plus a canonical JSON hash of request body and relevant semantic headers. Repeated same key + same input returns the original accepted status/body and stable logical references; GET retrieves current status; same key + different input returns 409. Concurrent same-key calls require a DB uniqueness claim or transaction-safe equivalent. Terminal error/retention choices must be specified per operation. **Phase 1B now models generic IdempotencyRecord; real transaction/constraint validation remains outstanding for every operation; this is a blocking schema reconciliation issue** before implementing all routes.

Do not retry AI/provider calls simply because the HTTP response was lost. Background jobs may run at least once; external side effects require dedupe and late-result fencing. Cancellation is never a guarantee that providers did no work.

## 6. Version and ETag contract

Server emits a strong ETag `"v<integer>"` for mutable resources. Client sends `If-Match` on PATCH and selected state-change POSTs. The service compares versions atomically, increments on success, returns latest projection/ETag. Stale/failed predicate returns 412. A missing required precondition returns 428 (not 400). Non-versioned append-only actions instead use idempotency and input consistency checks.

The **provisional database schema now models version columns and generic replay records**; guarded transaction behavior and retention rules still require validation/approval. Do not assume an ETag header alone prevents races.

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

`POST /api/v1/conversations/{conversationId}/messages`, `Idempotency-Key`, JSON `{"clientSubmissionId":"<uuid>","content":"Will people pay for this?"}` → `202` `{"messageId":"<uuid>","generationId":"<uuid>","status":"PENDING","statusUrl":"/api/v1/generations/<uuid>","eventsUrl":"/api/v1/generations/<uuid>/events"}`. After this, `GET /generations/{generationId}` yields durable status. `GET /generations/{generationId}/events` streams while generation is active, subject to Phase 2C rules.

### Approve memory proposal

`POST /api/v1/memory-proposals/{proposalId}/accept`, `If-Match: "v3"`, `Idempotency-Key`, optional JSON `{"approvedText":"Target is Bengaluru professionals"}` → `200` confirmed-memory DTO. Concurrent stale approval returns `412`. This requires proposal versioning in the database, not only revision history for the resulting memory.

### Create research request

`POST /api/v1/ideas/{ideaId}/research-jobs`, `Idempotency-Key`, `{"question":"What substitutes do customers use?","geography":"Bengaluru"}` → `202` `ResearchJob`; later evidence retrieval is separately authenticated and provenance-rich.

## 9. Current reconciliation gates

1. Generic ledger and mutable versions now have draft persistence fields; PostgreSQL/Prisma correctness and original-response reconstruction remain unexecuted (D02/D08).
2. DTO projections are specified in §11–12 and the integration matrix; controller/schema adapter conformance is untested.
3. Selected regeneration/transcript behavior is specified in the streaming contract and state machines; no historical branching in v1.
4. Account deletion design is complete in state-machines/physical-design; retention, stronger-auth and recreation policy require product approval (D12).
5. Evidence remains per-idea and claim/source scoped; provenance fields are explicit, independent claim verification is not implied by SOURCE_CHECKED.
6. SnapshotContent is typed/versioned under approved P2D-P05; runtime contract/parity proof remains D14.
7. SSE grammar and reconnect/no-replay semantics are specified in Phase 2C; transport integration remains unexecuted.
8. Clerk signature mechanism is documented in security §16; durable inbox and supported event subset are specified in security §16; pinned SDK/runtime proof remains D14.

## 10. Design review and acceptance

- Every route has a single owner module, auth policy, typed request/response and documented common error contract.
- Cross-owner and cross-idea negative tests exist for all private resource families.
- Long-running operations return durable job refs rather than holding a transaction.
- The OpenAPI YAML parses and has no unresolved local `$ref` pointers; API design approval does not mean running-server conformance.
- All remaining contract/schema and runtime proof gaps are tracked in the integration register before implementation approval.
- Streaming/idempotency drafts are reconciled; reviewer approval and runtime proof remain gates for the complete API contract.

**Decision status:** Proposed API contract baseline, ready for user/design review. **Not implementation-approved.**


## Phase 2D reconciliation amendment

See [integration review](../04-integration-review/integration-review.md) and its discrepancy register. §4 message ordering is amended to logical turn ordering anchored to trigger user sequence; physical message sequence remains append-only. §6 mutable version support is a required physical-schema amendment, not an existing implementation. The flat MessageSubmission in §8 and six-state generation lifecycle supersede older nested examples. Physical Phase 1B and Phase 2A exist; their outstanding design/validation gaps remain blockers. No prior reference certifies their existence.


## 11. Current reconciled field contracts

This section and the integration matrix supersede stale “next phase must decide” notes above. Generic replay and version fields are now modeled in Phase 1B; correctness is unexecuted. Every PATCH requires If-Match. preferences ETag uses UserAccount.preferencesVersion; conversation ETag uses Conversation.metadataVersion (public version); memory version maps currentVersion; snapshot ETag uses draftRevision, never immutable document version. Missing/malformed/stale preconditions return 428/400/412. Replay an already accepted command before checking its now-stale precondition, after current authorization.

ConversationPatch.proactiveResearch maps directly to Conversation.proactiveResearch. False prevents admission of new automatic research from that conversation, checked again inside the acceptance transaction. It does not revoke independently requested manual research or cancel previously accepted jobs; cancellation of existing research is not exposed in v1. Context builders must respect the setting after refresh.

MemoryPatch amendment (approved memory-removal policy P2D-P04) accepts exactly one of text or status=REMOVED. Removal atomically checks currentVersion, advances version, sets REMOVED and records a new immutable revision with actor/reason; subsequent active-context retrieval excludes it immediately. It neither erases historical revisions nor modifies approved snapshots; privacy purge handles erasure. Existing in-flight model requests may already contain previously authorized context: only requests assembling context after removal commit are guaranteed to exclude it. Prevent a late proposal from restoring REMOVED memory without a fresh explicit user approval. No restore command or automatic approval is introduced.

SnapshotContent is now a typed draft contract in OpenAPI: title, documentDate and bounded plain-text sections with knowledgeClass, sourceEvidenceIds and missingInformation. Immutable typed/versioned content is approved under P2D-P05; presentation remains a technical design choice. Canonical hash input is RFC 8785 canonical JSON of {schemaVersion,content}, UTF-8, SHA-256 lowercase hex. Validate unique section IDs, same-idea evidence IDs and required provenance; unknown facts remain UNKNOWN. Approved schemaVersion/content/hash stay frozen. SnapshotCreate/Patch.content use the same type; edits increment draftRevision and reset REVIEWING to DRAFT.

Evidence DTO maps sourceUrl to sourceLocator (only safe supported URI schemes, not a server fetch instruction). Return explicit nullable publisher/title/sourceObservedAt/retrievedAt/geography/period/limitations; unknown fields are null, never fabricated. SOURCE_CHECKED means locator/retrieval verification only; no conversion to confirmed memory. Findings with multiple independent sources use separate claim/source evidence records and links, not one field silently replacing sources.

Clerk wire envelope and svix headers are verified at the raw-body boundary; see [security §16](architecture-and-security.md#16-durable-clerk-webhook-and-identity-tombstone-design). OpenAPI describes the signed external envelope, not a trusted founder command. Inbox/tombstone persistence is now specified in physical §12; SDK/transaction proof is implementation-stage validation.

## 12. DTO-to-persistence mapping and remaining limits

| API field | Proposed persisted representation / validation |
|---|---|
| MessageCreate.content | Message.content JSON {text}; role/sequence generated by server; contentSchemaVersion=1 |
| clientSubmissionId | Message.clientSubmissionKey; submissionSha256 hashes canonical command, not bearer |
| Generation.selected / finishedAt / outputMessageId | selectedAt != null / completedAt / linked Message.id |
| MemoryProposal.proposedText | candidate.text; kind and provenance remain distinct; approvedText override feeds a user-authored revision |
| ConfirmedMemory.text / version | currentContent.text / currentVersion; removal status is authoritative |
| Experiment.method / successCriteria | plan.method / successCriteria JSON; actual request field names in OpenAPI govern adapters |
| Learning observation / reflection | observation / interpretation; origin USER_REPORT, approvedById principal only |
| ResearchCreate question / geography | query / budget.scope.geography; budget numerical quotas server-owned |
| Snapshot contentHash / draftRevision | contentSha256 / draftRevision; document version remains version |
| Export status / object metadata | ExportJob state, objectKey, fileSha256; URLs minted only after authorization |

JSON representation choices above are proposed adapter contracts, not existing code. Unknown fields fail strict validation. Create routes without an idempotency flag (conversation/assumption) do not currently promise transport dedupe; extending generic ledger coverage remains proposed. DataOperation manifest, inbox and tombstone are specified in physical-design §12–13 and state-machines; product approval and implementation validation remain separate gates.


## 13. Final memory contract (approved product policy; technical validation pending)

Canonical responsibilities: API authenticates owner, validates strict MemoryPatch or proposal decision, checks If-Match; application service owns atomic review/version/context invalidation; database supplies scope/unique/version constraints and immutable revisions; generation workers may only create PROPOSED rows. No LLM or webhook can approve memory. Dismissal maps to DISMISSED, not a separate REJECTED enum; terminal proposals never reopen. Candidate text is not confirmed context.

Approve transaction locks account -> idea -> proposal -> target memory, checks ACTIVE roots, proposal.version/PROPOSED and expectedMemoryVersion/currentVersion; target must not be REMOVED. Accept edited text is EDITED_AND_ACCEPTED; otherwise ACCEPTED. Write/update currentContent/currentVersion, append exactly one revision and sanitized audit, set resultMemoryId and reviewer/time, increment Idea.contextEpoch, and store idempotency outcome atomically. Same-key replay reauthorizes and reconstructs the accepted DTO from referenced immutable MemoryRevision/status, not the now-current text. Concurrent different-key approvals have one winner; stale proposal precondition is 412; already-terminal with a current version is 409. Stale target version returns 412 with safe TARGET_VERSION_CHANGED. Rollback yields no confirmed memory, revision or success message. Invalidating a stale proposal may occur only through a separate conditional system action, never a partial approval commit.

PATCH /memory/{memoryId}, If-Match, accepts exactly one of text or status=REMOVED. Text edit of ACTIVE memory increments currentVersion and appends revision. Removal locks the idea/memory, increments currentVersion, sets REMOVED, appends a revision whose content is a tombstone {removed:true} plus actor/reason/time, increments Idea.contextEpoch, invalidates PROPOSED edits targeting the removed memory, commits then returns ConfirmedMemory. Removed DTO text is empty string (no old value), status REMOVED; historical text remains only in authorized revision history until privacy purge. Ordinary listing/context uses ACTIVE predicate. Editing a removed memory is 409 MEMORY_REMOVED. No PATCH restore; a fresh explicitly approved proposal may create a new memory identity, never silently reactivate a removed one. PATCH has no ledger key; uncertain success is resolved by GET memory collection/revisions/version, and a repeated stale If-Match returns 412 rather than creating another revision. Removal is not a claim that historical conversations, provider requests or approved snapshots are erased.

### Context construction and removal race

Each memory accept/edit/remove increments Idea.contextEpoch in the same transaction. The context builder reads only ACTIVE roots/ACTIVE confirmed memory at currentVersion in a short consistent snapshot and captures epoch; cache entries bind idea, owner, epoch and memory versions. Before authorizing provider dispatch, lock account/idea and compare epoch/lifecycle; if changed, discard the built context and rebuild from current memory (no provider call yet). Persist GenerationAttempt.contextEpoch and dispatchAuthorizedAt with the successful dispatch authorization. No new entity or permanent prompt archive is needed. Deletion committed before that authorization forces rebuild/exclusion; an authorization already committed before deletion counts as an in-flight request, even if external delivery completes later. Never hold the DB transaction open across the model call. This boundary/caveat implements approved P2D-P04 and is disclosed; remote requests cannot be reliably recalled.

A final generation commit also matches saved contextEpoch to current Idea.contextEpoch. If memory changed after dispatch, discard output/proposals and settle FAILED with CONTEXT_CHANGED under current attempt epoch and status RUNNING; no automatic paid retry. Existing completed responses are immutable history, not future confirmed memory. Recent chat may still quote prior user text under SRS INV-005; it must not be labeled the current saved fact. Any explicit privacy-erasure request takes the scoped purge path, not just MemoryPatch. Cross-idea context caches are forbidden.

## 14. Final snapshot and export contract (documentation approved; runtime unvalidated)

SnapshotContent schemaVersion=1 is the conceptual reviewed document: title/date and ordered uniquely identified sections, each with heading, bounded plain text, knowledgeClass, authorized evidence IDs and explicit missing-information list. Order is meaningful; no arbitrary HTML, embedded URLs as fetch instructions, dynamic scripts or model-generated file paths. No evidence ID alone supplies historical citations: each EXTERNAL_EVIDENCE section additionally carries sourceReferences entries with evidenceId, sourceUrl, sourceTitle, sourcePublisher, retrievedAt, sourceObservedAt, geography, periodStart/End, trust and limitations (unknown values explicitly null). At review/approval those entries are projected from same-idea EvidenceRecord, not trusted client claims; IDs and metadata must agree in the locked approval transaction; changed source metadata returns 409 PROVENANCE_CHANGED for draft review instead of silently rewriting approved content. This bounded embedding preserves historical source attribution if active evidence later changes. Other section classes may carry matching source references but never elevate USER_REPORT/MODEL_INFERENCE to verified external evidence. Approved P2D-P05 preserves immutable typed content/version semantics; the section presentation is a documented technical default; no new snapshot entity is required.

Create makes DRAFT version allocated under idea lock; PATCH of DRAFT/REVIEWING uses draftRevision and resets DRAFT with incremented draftRevision. Approval POST requires confirmed=true, If-Match for draftRevision, Idempotency-Key and owner. It may transition DRAFT or REVIEWING directly to APPROVED; increment draftRevision, set approvedById/approvedAt and canonical contentSha256 in the same transaction. REVIEWING is optional UI state, not an unimplemented mandatory route. Validate all provenance, missing labels and same-idea refs before approval. hash=SHA-256(RFC8785 canonical JSON({schemaVersion,content}), UTF-8), lowercase 64 hex; exclude mutable transport/audit timestamps and URLs minted for download. No NaN/Infinity/duplicate object keys; normalize content at save using one versioned rule, then hash exactly that stored content. Arrays preserve order. Changing an approved snapshot needs a new POST snapshot intent; old version/hash/content never change, even after memory removal or evidence-link edits. Existing PDF dated citations remain historical, not current-verification claims.

Export admission checks ACTIVE roots and APPROVED snapshot under transaction, pins snapshotId/hash, creates ExportJob/outbox/ledger and returns 202. Worker renders frozen content only; provider/model never rewrites content after approval. Within-attempt safe render/upload retries retain job and bounded lease; terminal FAILED requires an explicit new export Idempotency-Key/job. Same original key always replays original 202/job even if that job later failed. Prior successful artifact stays usable until expiry/deletion; retries cannot replace another valid result. Attempt-specific storage prefixes are registered before upload for purge inventory; completion matches epoch, deadline, active roots and original hash, and stores objectKey/fileSha256/artifactState=AVAILABLE/artifactExpiresAt. Output bytes may contain renderer metadata; substantive approved content parity and recorded file checksum, not identical bytes across separate render jobs, is the guarantee.

GET export status exposes artifactState; COMPLETED execution is immutable while artifactState AVAILABLE -> EXPIRED/PURGED may advance. POST download-grant has no replay ledger (never reuse an expired signed URL), checks active account/idea, approved snapshot/hash and AVAILABLE object, then returns short-lived scoped access. Missing/foreign ->404; valid owner but expired/unavailable artifact ->409 ARTIFACT_UNAVAILABLE; storage uncertainty ->503. URL TTL is a five-minute bounded-export engineering default; the separate seven-day rendered-PDF cache remains a retention proposal, not an owner-approved hosting promise. Private object names are server-generated, MIME application/pdf, attachment filename sanitized, storage encryption configured, no public ACL. At artifactExpiresAt, a guarded transaction advances availability to EXPIRED and records durable cleanup work; no new grant is issued even if the storage delete is delayed. After all object versions are confirmed absent, janitor marks PURGED. EXPIRED means unavailable, not physically erased; terminal execution status stays COMPLETED. Privacy purge deletes snapshot history, all job versions/objects and manifests through the privileged scope path.

## 15. Final evidence and research-control contract

ConversationPatch.proactiveResearch and persisted Conversation.proactiveResearch already exist. Setting false commits under metadataVersion/If-Match, and automatic research admission rechecks this value inside its job/outbox transaction. The setting is effective at commit for newly accepted automatic jobs. Queued/running jobs accepted earlier continue under existing quota/lifecycle, manual research remains allowed, and no user-facing research-cancel route is implied. Account/idea deletion supersedes this policy and cancels/fences all scoped work. Replayed original accepted command is not a new automatic admission. Generation context assembler must reread setting/version, never rely on client flags.

Evidence ownership is idea -> owner. EXTERNAL_SOURCE, USER_REPORT and MODEL_INFERENCE remain distinct; sourceLocator/time/title/publisher/geography/period/trust/limitations remain explicit in database/API. SOURCE_CHECKED requires external origin, retrievable source attribution and retrieval time; it indicates a checked source, not confirmed truth. Missing temporal/geographic scope is explicit unknown and must not be presented as matching a locale/period without evidence. Research findings never automatically approve memory or settle assumptions. Preserve conflicting sources as distinct records; assumption evidence links SUPPORTS/CHALLENGES/INCONCLUSIVE do not mutate canonical Assumption.statement.

DELETE assumption/evidence-link removes only that relationship, not the finding or approved snapshots. There is no standalone evidence-erasure API in v1: an ordinary view may detach links, while true private-data erasure is available through owned idea/account deletion under FR-005. Adding per-evidence erase is a future product amendment, not silently missing scope. A deleted parent purges evidence and links, leaves unrelated ideas untouched, and deletes its snapshots/exports too. If a public source disappears, retain historical source locator/time with STALE/UNVERIFIABLE rather than fabricate verification. Approved snapshots embed the reviewed citation metadata, so active link edits cannot mutate immutable approved content. User observations and Learning interpretations remain separate.

## 16. Data-operation HTTP projection

POST /me/data-operations accepts kind, optional ideaId only when DELETE_IDEA or scoped EXPORT, confirmed=true for deletion, and policyVersion=p2d-privacy-v2 acknowledging the displayed approved core policy and truthful deployment-specific retention disclosures. Wrong conditional fields ->400; unknown/inactive policy version ->409 POLICY_NOT_ACTIVE. Core policy approval is recorded for p2d-privacy-v2; deployment activation still requires verified settings/provider disclosures and implementation gates. Authorized same-scope deletion replay resolves its stored policy/receipt before checking whether a policy for new work is active; it cannot initiate a new action. DELETE /ideas/{ideaId} remains lifecycle-idempotent and uses the same displayed-policy/fresh-auth checks, with X-Privacy-Policy-Version header (required; missing 400), not an unvalidated DELETE body. No If-Match is added for deletion: lifecycle CAS plus domain operation uniqueness governs it.

DataOperation DTO: id,kind,status, deletionState (null for EXPORT), policyVersion, requestedAt, livePurgedAt?, completedAt?, backupResidualUntil?, activePurgeTargetAt? (derived requestedAt + 30 days for deletion), capturedAt? (EXPORT cutoff), errorCode? (safe), and artifactState/artifactExpiresAt for EXPORT. Internal checkpoint, subject hash, storage key and provider payload never exposed. Status uses REQUESTED/RUNNING/WAITING_RETRY/REQUIRES_ATTENTION/COMPLETED/FAILED; deleted content availability never follows generic status alone. Deletion COMPLETED means live purge obligations resolved with disclosed backup residual, not instant backup destruction. Account export status GET may mint a fresh download {url,expiresAt} only for active owner and completed AVAILABLE export, no ledger or persisted signed URL. Blocked-account status exception gives minimal deletion progress only, no download. After provider account deletion no session-based progress read is guaranteed; store the initial receipt client-side for reference, never as bearer authorization.


## 17. Documented PDF export limits

P2D-P05 approves reasonable documented limits; these are conservative engineering defaults, not invented separately signed product numbers or measured performance claims. Reuse SnapshotContent v1 bounds (maximum 30 sections, 10,000 text characters per section, 50 evidence references per section). Enforce a 1 MiB UTF-8 serialized canonical content limit before approval/export (413 CONTENT_TOO_LARGE; no silent truncation). Maximum rendered PDF is 10 MiB; renderer execution deadline 60 seconds; at most two QUEUED/RUNNING PDF exports per account, admitted under an account lock/DB-backed quota reservation. Reject extra admission with 429 EXPORT_LIMIT_REACHED; quota replay resolves an already accepted intent before applying new-admission limits. Reject invalid request shape with 400; limit enforcement never weakens ownership checks.

A render exceeding duration or size settles the job FAILED with EXPORT_DEADLINE_EXCEEDED or EXPORT_TOO_LARGE, discards/cleans partial objects and preserves the approved snapshot. The client may explicitly create a revised NEW snapshot version or later retry using a new intent; never rewrite/truncate an approved snapshot to fit. Same Idempotency-Key still returns the original job reference. Download grants expire after five minutes; cached artifacts follow separately disclosed retention. These PDF bounds do not authorize the unrelated 20 MiB account-export capture/ZIP policy, which remains proposed in A08. Tune engineering capacity only with validation and documented review; changing privacy/immutability guarantees requires a new owner decision.


## 18. Phase 3 owner-approved assistant-response amendment

P3-P01 adopts versioned structured replies with exactly one primary strategy, optional singleton card and relevant evidence references. The principle and complete Phase 3 documentation package are owner-approved under P3D-A09; calibrated numeric limits and implementation results are excluded; see Phase 3D §11/17. This declared amendment updates current OpenAPI to0.3.0 and preserves historical A07 manifest. It does not change message POST/202 envelope, generation status/cancel/regeneration, auth, owner scope, selected logical-turn ordering or SSE grammar.

GET /conversations/{conversationId}/messages accepts optional query assistantResponseVersion=1|2, default1. Default1 returns the exact existing MessageList/Message projection with content:string and no extra assistantContent, so existing strict additionalProperties=false clients remain valid. Explicit2 returns StructuredMessageList: same original fields plus optional assistantContent on ASSISTANT only; USER and historical format1 rows omit it. Unsupported selector400 VALIDATION_ERROR; representation choice participates in signed cursor scope; changing selector with an old bound cursor400, never permission bypass. Cache-Control:no-store unchanged; no extra authentication method or public endpoint. OpenAPI anyOf documents overlapping legacy/structured lists (including empty lists), not permission to return2 without request opt-in.

AssistantResponse schemaVersion1 carries primaryStrategy (existing six-value ThinkingStrategy), optional card (oneOf assumption/evidence/comparison/experiment), citationRefs claimText/evidenceId/qualification, proposalIds,actions and optional nextQuestion. Main text remains Message.content; it equals stored JSON text. card is one object, never cards[]; unknown variant/schema fails closed. Proposal IDs reference already committed owner-scoped PROPOSED resources, not duplicate private content or automatic approval. Action types VIEW_EVIDENCE/OPEN_MEMORY_REVIEW/OPEN_EXPERIMENT_DRAFT/REQUEST_RESEARCH are presentation intents only; existing explicit owner commands/confirmation/If-Match and idempotency perform any durable action. No unrestricted URLs, arbitrary HTML, new automatic memory/experiment writes or implicit tool consent.

OpenAPI components AssistantResponse, ResponseCard, four typed card schemas, AssistantCitation,AssistantAction,StructuredMessage/StructuredMessageList define exact field names; their lengths/counts are provisional engineering settings consistent with the internal contract. Comparison option IDs/criterion values must match and be unique; all referenced assumptions/evidence/proposals belong to the authorized idea. Citation ID validity alone is insufficient: source/claim support, geographic/temporal caveats and provenance required. SOURCE_CHECKED never proves business truth. Text/card/question together honor the default one-primary-question and <=2 prominent actions; explicit user instructions still govern allowed detail. Invalid optional enrichment can drop only when remaining text independently safe/supported; material unsupported claims cannot be cured by cosmetic citation deletion. Bounded repair/fallback follows Phase3 principle P3-P04; no hidden provider retry.

Worker validates entire candidate before committing response/selected attempt/proposals/usage under RUNNING/current lease/ACTIVE roots/contextEpoch. Persist format2 {text,assistantContent} with Message.contentSchemaVersion2; assistantContent.schemaVersion1 is distinct from the persisted format version and opt-in HTTP version. Existing format1 {text} rows unchanged; no invented historical strategy/card backfill. See physical-design §15 for readers/rollout/rollback and minimal private orchestrationMetadata. Unknown versions fail closed. Endpoints never expose metadata/prompts/hidden reasoning. No structured object or card event is added to SSE; completed status still directs canonical authenticated transcript retrieval.

Compatibility/negative fixtures: legacy exact JSON/default parameter; explicit2 structured and mixed legacy rows; empty list anyOf; USER cannot include assistantContent; unknown query/version/card; two cards; foreign claim/proposal/assumption; mismatched strategy/text; cursor representation change; failed finalization without partial response; stale context/cancel. These are planned tests, not executed server conformance. Full Phase 3 documentation approval P3D-A09 is separately granted by the owner’s explicit complete-package instruction; exact revision FL-P3-0.3-approved.


## 19. Phase 4 controlled API amendments — approved design, not package sign-off

The owner explicitly approved FE4D-A01/A02/A03 and P4-AM01–04 in this conversation. These are design/controlled documentation approvals only: no approval timestamp, signature or commit was supplied; FE4D-A08 whole-package approval is still absent. Current OpenAPI is0.4.0. This section supersedes conflicting preliminary examples above and old smaller generation responses in streaming§2.1. [Change register](../06-frontend/controlled-amendments-0.3.json) records old/new raw-byte fingerprints; historical A07/P3 manifests stay unchanged. No service, database entity, Prisma field, SQL guard or migration is added.

### 19.1 P4-AM01: original submission correlation

GET /api/v1/conversations/{conversationId}/submissions/{clientSubmissionId}; both parameters UUIDs. Session Bearer only, active local account/idea, owner-scoped conversation and same-idea USER message required; no client userId trusted. Pure PostgreSQL read: Message.clientSubmissionKey=clientSubmissionId scoped by conversation, and its original triggering GenerationAttempt.attemptNumber=1 (never latest selected regeneration). Return200 SubmissionCorrelation {clientSubmissionId,messageId,generationId,statusUrl,eventsUrl}, all required; URLs server-derived relative references to the original attempt. No text, title, hash of private content, quota, provider data, idempotency ledger payload or current generation status. Missing original attempt despite message is invariant uncertainty503 PROJECTION_UNAVAILABLE, not permission to create one. No body, Idempotency-Key, If-Match, outbox write, queue delivery or paid/tool call.

400 VALIDATION_ERROR invalid UUID/unrecognized query,401 invalid session,403 known blocked lifecycle,404 NOT_FOUND missing/foreign conversation/submission,429 normal read rate limit,500 sanitized unexpected fault,503 temporary storage/invariant failure; errors use existing Error envelope. Cache-Control:no-store; normal CORS/authorized-party boundary.404 is deliberately neutral and **never proves noncommit**, including a concurrent submission not visible in the read snapshot. No status code authorizes automatic resend/regeneration; browser must not reconstruct lost private text from history. Same read may later return200; lookup remains read-only.

### 19.2 P4-AM02: full Generation success DTO

Cancellation POST retains no body and required Idempotency-Key.202 uses full Generation with status=CANCEL_REQUESTED;200 uses full Generation for an already terminal attempt. Regeneration POST retains RegenerationCreate {triggerMessageId}, required Idempotency-Key,202 full Generation status=PENDING and Location; it never inserts a new USER turn. Required full Generation fields are id,conversationId,triggerMessageId,status,selected,createdAt; optional outputMessageId,startedAt,finishedAt,error follow unchanged schema. Same-key retry after authorization returns the **original accepted status/body snapshot**, not current terminal fields or latest selected attempt; GET generation obtains current truth. Safe operational acceptance fields can be captured in existing responseRef, not prompts or private message bodies. Completed-first/cancel-first, fencing/contextEpoch, six states, latest-turn eligibility, usage/outbox and selected-response rules are unchanged. Snapshot approve201 is retained; generic decision200 prose is not an override.

### 19.3 Shared explicit projection negotiation

Only these operations accept optional query projectionVersion=1|2, default1:

| Operation | Legacy/default DTO | Explicit2 DTO |
|---|---|---|
| GET /api/v1/ideas/{ideaId}/memory-proposals | ProposalList/MemoryProposal | ProposalListV2/MemoryProposalV2 |
| GET /api/v1/ideas/{ideaId}/experiments | ExperimentList/Experiment | ExperimentListV2/ExperimentV2 |
| GET /api/v1/ideas/{ideaId}/learnings | LearningList/Learning | LearningListV2/LearningV2 |
| POST /api/v1/experiments/{experimentId}/learnings | LearningCreate→201 Learning | LearningCreateV2→201 LearningV2 |

Default request/response schemas remain exactly the legacy strict objects, including legacy reflection and no new properties. No other operation silently accepts this query; unknown values/mismatched request shape400 VALIDATION_ERROR. It is distinct from entity version, snapshot schemaVersion and assistantResponseVersion, which remains unchanged. OpenAPI anyOf declares alternatives, not cross-parameter validation; application validation must select the exact schema for the negotiated request. No dual reflection/interpretation aliases. Lists retain limit1–100/default25 and opaque page {nextCursor,hasMore}. Signed cursors bind owner/idea/resource/filters plus projection; old cursors continue only with projection1; selector mismatch400, never silently restart/reuse pages. No new ETag shape/precondition.

LearningCreateV2 keyed fingerprints include normalized projectionVersion=2 and its exact canonical body/preconditions using existing algorithmVersion. Default1 keeps the legacy fingerprint algorithm and original response schema, not a global recomputation. Same key switched to another projection is409 IDEMPOTENCY_KEY_REUSED. Replay resolves original accepted representation after current authorization before stale-precondition/new quota checks. Learning is immutable after creation except scoped privacy purge, so responseRef can identify the original row+projection for reconstruction; never return projection2 on a replay of projection1. Changing representation for a **read** is a GET with a fresh scoped cursor, not a new mutation. Experiment/proposal write routes remain legacy response shapes; UI refetches the negotiated list after writes. This avoids adding arbitrary new replay storage of mutable private fields.

### 19.4 P4-AM03: minimal version-safe memory review

MemoryProposalV2 requires id,ideaId,kind,proposedText,status,version,source. version=actual MemoryProposal.version; proposedText=candidate.text (nonempty<=5000). Other legacy enums remain. Source is strict {availability:AVAILABLE|UNAVAILABLE|UNKNOWN,messageId:UUID|null,conversationId:UUID|null,messageRole:USER|ASSISTANT|null}. AVAILABLE requires all three identifiers/role values from a currently owner-authorized same-idea source Message/Conversation. UNKNOWN means no source recorded; UNAVAILABLE collapses missing/deleted/foreign/ineligible source; all IDs/role null for either. No excerpt, title, raw provenance JSON, author subject, target-memory content or hidden reasoning is copied. Author role describes attribution, not factual verification. A source with uncertain ownership never yields partial identifiers; source lookup is not an external fetch. Normal retained history can be linked as history under P3 removal limits, never reintroduced as current confirmed memory.

Map actual proposal version/text, never invent legacy values. Invalid persisted required review text/version fails safe503 PROJECTION_UNAVAILABLE and needs repair; no fabricated blank draft or hidden auto-approval. A null/legacy provenance JSON need not prevent source UNKNOWN. API returns only authorized source IDs; source deletion/privacy rules still apply on each read. No new column or proposal-detail GET is needed. Use quoted If-Match:vN from the returned actual version; accept/dismiss still require their existing key/version guards and targeted expectedMemoryVersion check server-side. Atomic ProposalDecision.approvedText supports edit-and-accept. Ordinary PATCH/dismiss responses stay legacy; refetch projection2 after commit. Target fields are not client-authoritative and no worker can approve, restore REMOVED memory or expose another idea. All source/time/claim class uncertainty remains labeled.

### 19.5 P4-AM04: observations, interpretations, plans and relationship reads

LearningCreateV2: required interpretation plain text1..10000; optional observation string<=10000 or null (omission→null); optional evidenceIds retains existing UUID array cap20. Unknown fields/reflection alias400. LearningV2 requires id,ideaId,experimentId(nullable),observation(nullable),interpretation. Legacy reflection still maps the same persisted Learning.interpretation only under projection1. Observation maps only Learning.observation; never infer it by parsing or duplicating interpretation. Origin USER_REPORT/approvedById are server-owned; this remains the existing explicit founder create action linked by experiment route, with same-idea FK/auth. No observation edit, extra approval action or independent Learning endpoint is added. Existing unknown observation remains null, displayed as not recorded.

ExperimentV2 adds required nullable method and successCriteria to the existing Experiment fields. method=plan.method when a supported bounded string (<=5000), successCriteria=the existing JSON string scalar when supported (<=2000), otherwise null. Do not stringify arbitrary legacy objects, truncate invented prose or assert unsupported JSON as known data. Null means unknown/unmapped, not a measured failed experiment. Existing create/PATCH shapes and optimistic version rules remain unchanged; success criteria read-back does not invent a new PATCH field. UI allows only fields actually writable. Existing title/hypothesis persistence ambiguity is explicitly P4-B01 below, not guessed.

GET /api/v1/assumptions/{assumptionId}/evidence-links adds a minimal relationship-only read. Session Bearer, active local account/idea, owned assumption and all evidence relationships same idea. No body/key/If-Match; limit1–100/default25,cursor. Return200 EvidenceLinkList {items:[EvidenceLink {assumptionId,evidenceId,relationship}],page:{nextCursor,hasMore}}. Stable sort (createdAt,evidenceId); cursor binds local principal/idea/assumption/filter scope, no cursor reuse across users. No note, private source body, source-fetch instruction, total count or trust setter. Empty owned set200 items[]; missing/foreign404;400 malformed UUID/cursor/query,401 session,403 lifecycle,429 read limit,500/503 safe errors. Cache-Control:no-store. Existing EvidenceLinkCreate/unkeyed relationship mutation/composite identity and parent purge rules stay unchanged; evidence detail uses owned paginated evidence projections. No entity/table/index/migration is assumed necessary.

### 19.6 Unexpected persistence mapping blockers — not resolved by owner principle approval

P4-B01 (high): ExperimentCreate/Experiment require title, but Prisma stores required hypothesis and JSON plan; inspected prior LLD maps method but not title/hypothesis. Do not silently decide title=hypothesis, change existing rows or add a required request field. Recommended technical amendment for review: explicitly version plan.title as the editable UI title while preserving a separately meaningful required hypothesis with an approved source/default rule. That rule still needs review; no auto-generated hypothesis or silent new business field is authorized. Full experiment create/edit/reload acceptance remains blocked until this mapping is decided.

P4-B02 (high): existing LearningCreate.evidenceIds has no declared Learning↔Evidence storage mapping in Prisma/physical LLD. AssumptionEvidence is not a learning-specific association and cannot silently substitute. Nonempty evidenceIds must not be ignored or claimed persisted: fail closed409 EVIDENCE_MAPPING_UNRESOLVED until a controlled mapping is approved, on either input projection; empty/omitted evidenceIds uses existing experiment/idea relation and observation/interpretation columns. This safety gate is explicit, not a claim the old unsupported path was implemented. Recommended review: choose whether evidence links belong to the experiment's assumption or need a learning-specific relationship; either requires scope/retention/compatibility analysis and explicit approval before adding any entity. No new database model is introduced now. This blocker remains on legacy as well as negotiated data, not hidden by null read fields.

These are missing **design mappings**, not merely deferred runtime tests. Until resolved, do not claim complete P0 roundtrip readiness or unconditional Phase4 documentation sign-off. API/schema agreement for the four authorized amendments does not fabricate a storage decision. Planned tests: CT-P4-01–08, DB-P4-01–05, F4D-01–40 plus new F4D-38/39 assertions, all unexecuted.

## 20. Mapping-resolution proposals — Pending Owner Approval

Historical v0.4 proposal record. The owner has now explicitly approved P4-B01/P4-B02;**current normative contract is§21**,including the minimal create3 receipt andexplicit legacy rejection policy. Pending statuses andalternative choices below describe the earlier investigation,not current unresolved decisions. Preserve them as evidence,not active schema definitions.

These proposals clarify P4-B01/B02 after inspecting the current OpenAPI components,Prisma models,logical/physical specs,existing FKs/guards andapproved product requirements. **They do not change active OpenAPI0.4.0,route inventory,Prisma,SQL or53 operations.** The seven earlier approved decisions remain accepted;no new schema/compatibility choice orFE4D-A08 package sign-off is inferred. [Physical§17](../01-database/physical-design.md#17-final-mapping-investigation-and-precise-proposals--pending-owner-approval) owns exact database changes,migration andMAP-01–10 tests. Current API§19.6 guards remain until explicit approval andvalidated rollout.

### 20.1 P4-B01 proposed contract andcompatibility decision

Recommend storing a user-visible label only in plan.title,method only in plan.method andthe actual hypothesis only in Experiment.hypothesis. An experiment title is not a testable claim. Do not add a redundant title column orauto-copy title/Assumption.statement into hypothesis. Preserve existing required stored hypothesis andall existing rows;introduce explicit hypothesis input in negotiated version3. Because the current legacy create body cannot supply a hypothesis,**unconditional successful legacy create is not compatible with this recommendation**. Owner approval must explicitly accept the upgrade/error path below orchoose another reviewed design;it cannot be called a documentation-only correction.

Exact proposed changes,not currently admitted query values:

| Existing operation | Proposed addition | Default/older representation |
|---|---|---|
| GET /api/v1/ideas/{ideaId}/experiments | projectionVersion3→ExperimentListV3 | Existing1/2 schema definitions remain unchanged |
| POST /api/v1/ideas/{ideaId}/experiments | optional projectionVersion1|3,default1;3→ExperimentCreateV3 and201 ExperimentV3 | Legacy title/method shape still parses,but recommended409 EXPERIMENT_HYPOTHESIS_REQUIRED instructs explicit client upgrade;do not invent missing hypothesis |
| PATCH /api/v1/experiments/{experimentId} | optional projectionVersion1|3,default1;3→ExperimentPatchV3 and200 ExperimentV3 | Existing PATCH1 fields/response/If-Match stay unchanged;rename changes only plan.title |

Proposed strict ExperimentCreateV3: required title(string1..200),method(string1..5000),hypothesis(string1..5000);optional assumptionId(UUID),successCriteria(string<=2000). Values are proposed engineering bounds,not new measured/product-approved limits. Founder may review an existing assistant experiment-card hypothesis before submitting;no model auto-approval. ExperimentPatchV3 permits the existing title/method/status fields plus an explicitly supplied nonempty hypothesis,requires at least one field andthe existing versioned state guards. It does not add successCriteria editing ora new lifecycle. ExperimentV3 retains ExperimentV2 fields,adds required hypothesis:string,andallows title:string|null for genuinely unrecorded legacy labels. ExperimentListV3 retains items/page Pagination. No new endpoint,auth mode,entity,worker orstate.

Version1/2 read schemas are unchanged;rows with no valid supported plan.title cannot silently return null orcopy hypothesis into required title. Recommended safe503 PROJECTION_UNAVAILABLE andmanual data review makes that limitation explicit. Version3 null title means not recorded;current hypothesis remains the actual stored value. New confirmed title writes populate only the typed JSON key. Nonobject/unsupported old plan409 LEGACY_PLAN_REQUIRES_REVIEW until explicitly reviewed conversion;no automatic backfill ordiscard of other JSON content. Proposed error codes belong to this unapproved proposal,not an active behavior claim.

Existing session Bearer,active local-account/idea,owner/same-idea assumption checks,If-Match428/400/412,conflict409 andsanitized Error remain. Create3 requires the existing Idempotency-Key andrecords the original accepted response representation;new projection3 fingerprint binding must not rewrite existing1/2 fingerprints. Different projection under the same key409. Experiment is mutable: before enabling a richer201/200 body,the replay design must demonstrably preserve the original accepted fields rather than re-read changed current plan/hypothesis. Existing responseRef/retention/privacy restrictions must be reviewed;do not claim a historical snapshot exists merely because a version counter exists. If exact private-response reconstruction cannot be supported without an additional approved storage decision,keep create3 disabled andreport that implementation/design gate. PATCH remains unkeyed/CAS-protected,not automatically replayable. Ordinary GET may show current data only after current authorization.

Alternative considered,not selected: nullable legacy Experiment.hypothesis could preserve legacy create availability,butweakens the SRS§7.1 mandatory attribute andrequires explicit requirement/schema policy approval. A dedicated nullable title column would addDDL without resolving that missing hypothesis input. No such change is made. The recommended version3 input plus distinct plan.title is the smallest truthful mapping that preserves hypothesis meaning;its legacy-create availability tradeoff needs owner acceptance.

### 20.2 P4-B02 proposed request persistence andread-back

After explicit approval,existing LearningCreate1(reflection) andLearningCreateV2(interpretation/observation) retain their current body schemas andcaps. Persist evidenceIds in proposed LearningEvidence in the same owner-authorized transaction asLearning/ledger,using distinct IDs without changing legacy fingerprint semantics. Omitted/empty set is explicitly captured with evidenceLinksRecorded=true;any invalid/foreign/missing evidence fails safely androlls back the entire Learning. No automatic AssumptionEvidence write,private-text serialization ormodel approval. Until migration/writer/schema review succeeds,the current409 EVIDENCE_MAPPING_UNRESOLVED gate stays in force;this proposal does not remove it.

Read-back needs a negotiated projection because strict existing Learning/LearningV2 cannot receive extra properties:

| Existing operation | Proposed addition | Compatibility |
|---|---|---|
| GET /api/v1/ideas/{ideaId}/learnings | projectionVersion3→LearningListV3 | Exact1/2 response shapes unchanged |
| POST /api/v1/experiments/{experimentId}/learnings | extend existing selector1|2 to1|2|3;3 usesLearningCreateV3→201 LearningV3 | LearningCreateV3 uses the same fields/bounds asLearningCreateV2;old1/2 shapes unchanged;after approved rollout all accepted evidence sets become durable |

Proposed strict LearningV3 extends LearningV2 with required evidenceLinkage:RECORDED|LEGACY_UNKNOWN andevidenceIds:unique UUID array0..20|null. RECORDED requires an array sorted by canonical UUID (including a genuine empty set);LEGACY_UNKNOWN requires null. Markerfalse with no stored links is old unknown intent,not proof no sources were supplied. Markerfalse withunexpected links is an invariant error503 PROJECTION_UNAVAILABLE,not a partial source disclosure. Return IDs only after current same-idea authorization of all associated evidence;unexpected scope corruption503 andnormal foreign/missing resources neutral404. No title/body/source excerpt is duplicated. LearningListV3 retains items/page andexisting cursor limits;bind version3 to signed cursor/fingerprint scope. POST3 permits no raw ownerId/origin/approvedById,unknown field aliases400. Nonempty malformed/over-limit input400;ordinary auth401/403/404 andexisting429/500/503 apply. No new method/route,status/lifecycle orordinary association edit action is introduced.

Current50 founder/53 total operations stay unchanged if these existing routes are extended later. Active operation/parameter schemas remain untouched now. After approval,controlled changes are required in OpenAPI newV3 schemas/selected parameter enums,inventory projection mappings,API/security/reliability examples,physical/Prisma/SQL/purge design,frontend read/write selection andacceptance fixtures. Existing source/time/trust metadata remains on EvidenceRecord;an evidence reference is not automatically verified knowledge. No previously approved snapshot changes when a relationship is added/removed by authorized privacy purge.

### 20.3 Owner decision boundary andacceptance

| Decision | Recommended proposal | Current status |
|---|---|---|
| P4-B01-D01 | Separate plan.title mapping;explicit hypothesis version3 input;preserve NOT NULL;explicit legacy-create upgrade/error policy | Pending Owner Approval;not fully closed |
| P4-B02-D01 | One LearningEvidence domain join,Learning capture marker/composite uniqueness,version3 source-ID read-back andatomic privacy-safe capture | Pending Owner Approval;new schema not accepted orapplied |

MAP-01–10 supplement existing F4D-18/29/36/38 andSRS FR-004/005/028/031–033 acceptance. Historical approval manifests andcontrolled register remain verbatim;[proposal change record](../06-frontend/mapping-proposals-0.4.json) separately records investigation edits/fingerprints. No production data,migrations,Prisma/SQL/provider/browser/security/model tests are asserted. A precise proposal is reviewable;it is not an approval orproof the two blockers are resolved.

## 21. Approved final mapping contracts — P4-B01 and P4-B02

**Approval evidence:** the owner's explicit instruction approves P4-B01 andP4-B02 for controlled design/documentation amendments. No date,timestamp,signature orcommit was supplied or inferred. These decisions close the mapping-design blockers,not runtime tests orFE4D-A08. OpenAPI0.5.0/route inventory/Prisma/guards now represent this design;none is an executed migration. [Physical§18](../01-database/physical-design.md#18-approved-final-mapping-design--p4-b01-and-p4-b02) owns persistence/marker/purge/migration details. Historical§19.6/§20 block descriptions are superseded;legacy integrity andprivacy guarantees are unchanged.

### 21.1 Experiment mapping andlegacy creation policy

Verified Prisma fields: hypothesis is required String,@db.Text;plan andsuccessCriteria are required Json;there is no nullable experiment draft orseparate title column. Store display title only in plan.title,method in plan.method andthe actual claim only in hypothesis. New create3 requires explicit nonempty title/method/hypothesis;an owner may review existing assistant-card suggestions,butthe server never manufactures a hypothesis from title,current assumption ormodel text. New accepted rows satisfy all required fields;initial status follows existing SUGGESTED default andnormal accepted transitions,not a new draft state.

| Operation | Admitted selector / exact success | Body andcompatibility |
|---|---|---|
| GET /api/v1/ideas/{ideaId}/experiments | optional projectionVersion1/2/3,default1;200 ExperimentList/ExperimentListV2/ExperimentListV3 respectively | Existing pagination/owner checks;cursor binds representation;unknown/mismatched cursor400 |
| POST /api/v1/ideas/{ideaId}/experiments | optional1/3,default1;fresh3→201 ExperimentReceiptV3;historical accepted1 replay retains original201 Experiment | Create3=ExperimentCreateV3;legacy1 shape unchanged butfresh request rejects409 EXPERIMENT_HYPOTHESIS_REQUIRED;selector2/unknown400 |
| PATCH /api/v1/experiments/{experimentId} | optional1/3,default1;200 Experiment orExperimentV3 | Existing If-Match required;legacy patch unchanged;3 usesExperimentPatchV3 andmay explicitly change hypothesis independently |

Create3 strict body: title1..200,method1..5000,hypothesis1..5000 strings required;optional assumptionId UUID,successCriteria<=2000. Bounds are configurable engineering defaults. Store criteria as JSON string scalar orJSON null when absent (required Json field does not mean an unprovided criterion is known);do not store a made-up success threshold. New plan object contains the supplied title/method. Patch3 requires at least one supported title/method/hypothesis/status field;strings are nonempty,bounds matchcreate,states remain PLANNED/IN_PROGRESS/COMPLETED/CANCELLED under existing guards. No new successCriteria edit action. Rename merges only plan.title;method merges only plan.method;preserve unrelated JSON keys. Atomic version compare/increment protects all fields,including hypothesis. Missing428,malformed400,stale412 andexisting state409 remain. Unsupported/nonobject legacy plan409 LEGACY_PLAN_REQUIRES_REVIEW rather than destructive JSON replacement.

Fresh legacy title/method-only creation cannot satisfy the current required hypothesis. **Compatibility is explicit andlimited:** request/response definitions1/2 stay unchanged,normal reads/patches remain available when values can be projected,andaccepted same-key receipts resolve before the new-admission guard. A fresh default1 create receives409 withsafe Error.code=EXPERIMENT_HYPOTHESIS_REQUIRED andupgrade guidance;no row,quota/provider call orincomplete draft is created. This is a documented availability/upgrade risk forold creation clients,not a claim all old successful-create behavior can remain supported. No silent data invention orhypothesis-nullability change is authorized. Existing projection2 oncreate remains invalid400,as before. A rejected,unaccepted intent can be deliberately resubmitted as3 witha new key/body after user correction;an uncertain old accepted intent never rotates keys automatically.

ExperimentV3 is a strict current view with existing id,ideaId,assumptionId?,status,version,method,successCriteria plus required hypothesis:string andtitle:string|null. Only3 mayrepresent unrecorded/unsupported historical titles asnull. Read1/2 cannot return breaking nulls orcopy hypothesis;503 PROJECTION_UNAVAILABLE when a supported required title is absent. No bulk title backfill orJSON rewrite. Existing hypothesis values remain intact. Legacy empty/unsupported JSON isnot normalized into invented knowledge.

Create3 uses the **minimal operational receipt** {id,ideaId,status,version},all required,withETag atacceptance. This intentionally refines the earlier unapproved proposal for a full private response: full text is retrieved through authorized list3 after acceptance. The small original201 snapshot fits existing IdempotencyRecord.responseRef without duplicating mutable private plan/title/hypothesis. Same-key replay after authorization returns exactly that original receipt/status/version,never current mutable fields;GET obtains current truth. Old accepted1 replay retains its original representation. Fingerprints bind selected projection andsemantic body;old algorithm1/2 meanings are not recomputed;changing projection/payload under a key409 IDEMPOTENCY_KEY_REUSED. PATCH remains unkeyed andCAS-protected,not a transport-replay promise. No new response-history entity orprivate prompt storage.

### 21.2 Durable LearningEvidence andread-back

Current Prisma design adds exactly one association model LearningEvidence(ideaId,learningId,evidenceId),PK(learningId,evidenceId),two same-idea composite FKs toLearning/EvidenceRecord,ON DELETE RESTRICT. Learning gains unique(id,ideaId),evidenceLinksRecorded Boolean defaultfalse andreverse relation;EvidenceRecord gains reverse relation. Marker is capture completeness,not approval,trust orverification. Historicalfalse means LEGACY_UNKNOWN;new accepted Learning creates explicitly inserttrue withthe entire distinct set,including empty/omitted selection. No persistedfalse→true backfill,ordinarytrue→false reset orordinary membership rewrite is offered. No Learning PATCH orstandalone association mutation endpoint is introduced. ExactSQL/service boundaries are inphysical§18.

LearningCreate1 remains reflection/evidenceIds;2 remains interpretation/observation/evidenceIds;3 usesLearningCreateV3 withthe same strict fields/bounds as2. All accepted versions atomically capture their evidence set after validated schema/writer rollout;the old EVIDENCE_MAPPING_UNRESOLVED gate is no longer the selected design. Do notenable success on an old writer that drops associations. Validate max20 raw UUIDs;store distinct membershipwithout changing existing fingerprint treatment ofarray order/duplicates. Current owner/activeidea/experiment andevery evidence must matchthe same idea;missing/foreign IDs neutral404 before commit,malformed/over-limit400. Origin/approvedById remain server-owned. No automatic AssumptionEvidence attachment orclaim promotion.

Lock established lifecycle order;in one PostgreSQL transaction claim/replay ledger,insert Learning(markertrue),insert distinct LearningEvidence rows andcapture original response reference. Failure rolls back all rows andreceipt. Same-key replay returns the original row/representation andcreates no links again. No business update toLearning orcaptured set is allowed;new explicit Learning records are existing journey actions,not editing history. SQL PK/FKs enforce uniqueness/same idea;guards serialize per-parent count<=20 andforbid ordinary UPDATE/DELETE. The initial-create-only INSERT rule andfounder authorization are application use-case responsibilities;SQL is not claimed to prove them independently. Table/grants/role/service concurrency tests remain unexecuted.

| Operation | Exact selected representation | Compatibility |
|---|---|---|
| GET /api/v1/ideas/{ideaId}/learnings | projectionVersion1/2/3,default1→LearningList/LearningListV2/LearningListV3 | Existing1/2 properties unchanged;cursor binds selection |
| POST /api/v1/experiments/{experimentId}/learnings | optional1/2/3,default1;201 Learning/LearningV2/LearningV3 | Existing1/2 bodies/results unchanged;all accepted versions persist links;3 changes read-back only |

LearningV3 extends strict LearningV2 with required evidenceLinkage=RECORDED|LEGACY_UNKNOWN andevidenceIds=unique sorted UUID array0..20|null. True→RECORDED,array includingempty;false→LEGACY_UNKNOWN/null. Legacyfalse plusunexpected join rows is503 PROJECTION_UNAVAILABLE;never expose a misleading partial/foreign set. Reauthorize wholeparent/linked evidence scope onreads/replay. Existing observation:null remains unknown;interpretation neverbecomes observation. Retained evidence metadata stays onEvidenceRecord,not copied intoLearning. Read andwrite3 selectors areexplicit;unknown value/aliases400 andsame-key selector changes409. Private no-store,CORS/session Bearer,401/403/404,429/500/503 andall existing bounds apply.

### 21.3 Deletion,rollout andclosure

ON DELETE RESTRICT prevents accidental normal-history unlinking,not legitimate erasure. Scoped account/idea deletion gates access first,thenprivileged cleanup removes LearningEvidence beforeLearning/EvidenceRecord andfollows existing backup/watermark/retention rules. No standalone source erase/edit ornew retention period. Approved snapshots remain immutable andparent privacy-deletable. Marker/reset/link immutability guards permit only role/operation/scope/lease-authorized DELETE,not ordinary UPDATE. Routine trigger disabling is not a purge strategy.

Migration design: addcapture marker defaultfalse (existing records unknown),Learning compositeunique,join/FKs/indexes andreviewed guard changes;all24 models are documentation artifacts. No destructive backfill,hypothesis-nullability change orassumed installed schema. Review existing JSON shapes,preflight constraints anduse expand/gate/validate rollout;new typed title CHECK is NOT VALID to preserve unreviewed legacy rows,thenreview before validation. Deploy allwriters/readers/purge support before enabling captured writes/projection3. Rollback disables newfeature admission while retaining data/compatible readers andpurge;never drop populated provenance orreturn toinvented title/hypothesis behavior.

P4-B01/P4-B02 are **resolved in approved documentation design**,withthe legacy-create compatibility limitation disclosed. Implementation,Prisma/SQL/migration,provider/security/browser/accessibility/model checks remain pending. MAP-01–10 andnew MAP-11–15/F4D runtime scenarios remain Not executed. **FE4D-A08: Approved — Documentation Only**, FL-P4-0.5-approved; see the [approved manifest](../06-frontend/approved-revision-0.5.json). The [controlled mapping change register](../06-frontend/controlled-mapping-amendments-0.5.json) preserves the previous stage's records andold/new fingerprints;its historical package-pending status is superseded by this explicit final approval,not rewritten.

## P5-AM01 controlled deletion amendment - approved design

The current [independent deletion protocol](../04-integration-review/state-machines.md#p5-am01-approved-independent-deletion-admission-protocol) is normative for this later owner-approved amendment. Independent durable intent precedes primary deletion commit;202 still requires the committed DataOperation/lifecycle/idempotency/outbox transaction and immediate access blocking. Intent is not proof of primary commit. Scope/incarnation-bound conditional intent writes and existing Idempotency-Key converge on one operation; changed fingerprint409. Proven unavailable-before-intent and uncertain outcomes use sanitized existing503, never a false202 or automatic new-key resend. Existing primary status GET/404 cannot prove absent independent intent. No new endpoint/status DTO is promised.

Unresolved intents block private access and sensitive worker reads/finalization until safe reconciliation; unavailable/stale independent authority fails closed. Existing fresh-auth, ownership, contextEpoch, leaseEpoch, purge ordering and account-incarnation rules remain. The frontend retains only approved opaque recovery identifiers and shows uncertainty, not automatic resend. No private text in the independent record. Physical design reuses existing operation UUID/scope/receipt/checkpoint metadata: generated migration review must prove operation-ID reservation and bounded reference encoding; no new entity/column or executed SQL is asserted. No remote call belongs inside a primary transaction. Old accepted responses remain replayable only through current narrow authorization and suppression checks. Export-only operations are unaffected. The independent-store dependency changes availability and admission semantics; earlier Phase4/A07 member hashes remain historical, not current. Schema/role/provider/security/browser/restore tests remain unexecuted.
