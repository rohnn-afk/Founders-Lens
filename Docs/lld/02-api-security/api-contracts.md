# Founder's Lens — LLD Phase 2B: API Contract Design

**Version:** 0.2 (design review)  
**Status:** In Review — documentation only; approval and execution evidence tracked separately
**Baseline:** Repository PRD/SRS/HLD with approval provenance tracked in Phase 2D D01; accepted Express ADR; Phase 1A logical model and Phase 2B/2C drafts. Physical Phase 1B and Phase 2A are now present and In Review; runtime validation remains unexecuted.
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

**Detailed path/method/schema inventory is in `route-inventory.json`; machine-readable operations are in `openapi.yaml`.** The inventory totals 48 protected operations plus two operational probes and a Clerk webhook. Routes belong to the authenticated founder only unless specifically stated otherwise.

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

## 14. Final snapshot and export contract (technical In Review)

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
