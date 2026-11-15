# Discrepancy register

**Status:** Approved Phase 2D documentation (A07); original findings below are historical. Runtime acceptance remains unexecuted.

**Current status: A07 approved (FL-P2D-1.0-approved); D12/D13/D14 core policies approved. Read the final disposition for current status.**

## Historical findings — superseded statuses preserved

The original tables below preserve historical findings. The final closure disposition is authoritative for current resolution. All section references identify the reviewed baseline; draft fixes are not product approval or runtime validation. “Resolved in draft” means documentation agreement only.

| ID | Severity | Documents / exact sections | Conflict or missing requirement | Impact | Recommended canonical decision | Required changes | Acceptance scenario | Resolution status |
|---|---|---|---|---|---|---|---|---|
| D01 | high | PRD header; SRS §16; HLD header; Phase 1A Sources; 2B/2C Baseline | Downstream says approved and references then-unavailable 1B/2A; now supplied | False implementation readiness | Preserve header status; require sign-off evidence | Add baseline clarification and inventory | Approval evidence audit | Open |
| D02 | blocker | Phase 1A §3,6,8,12; 2C contract-delta §Phase 1B | Initial audit lacked artifacts; now physical design, Prisma, SQL and test plan present; no executed report | Uniqueness, isolation and version guards unproven | Physical 1B must implement mapping obligations | Extend logical design; do not invent runtime validation | Real PostgreSQL migration and race suites | Static gaps corrected; runtime proof remains blocker (evidence below) |
| D03 | high | 2B OpenAPI servers; paths | Server and paths both contain /api/v1 | Clients call doubled prefix | Origin-only server; retain inventoried paths | Correct server URL | Resolve server + path for all operations | Resolved in draft |
| D04 | high | 2B Generation; 2C §2.4; SRS §8.1; HLD §8 generation lifecycle | INTERRUPTED versus CANCEL_REQUESTED; ambiguous cancel-to-complete prose | False completion after cancel | Six-state lifecycle with atomic predicates | Align OpenAPI and mapping; clarify prose | R04/R05 plus cancel/failure race | Resolved in draft |
| D05 | high | 2B API §8; OpenAPI MessageSubmission; 2C §2.1 | Nested submission versus stable references | Frontend cannot recover lost acceptance | Flat messageId/generationId/status/statusUrl/eventsUrl | Align example and schema | C01/I01 | Resolved in draft |
| D06 | high | 2B cancel operation and inventory; 2C §2.1 | Missing idempotency header and 202 cancellation response | Duplicate/ambiguous cancellation | Required key; 202 requested, 200 terminal | Update inventory/OpenAPI | R01/R04/R06 | Resolved in draft |
| D07 | high | Phase 1A §3 note; API §5; 2C §3.1,3.4 | Generic ledger optional; latest-status replay differs from original response | Two dedupe authorities disagree | One request ledger; chat uniqueness is permanent business constraint; original response replay | Clarify logical 21st entity and replay ordering | I01-I09; expired key | Resolved logically; D02 blocks physical proof |
| D08 | high | API §6; inventory version flags; logical catalog | Versions not specified for all mutable projections | Lost updates | Atomic integer versions; mapping lists required fields | Document required schema amendment; missing/stale 428/412 | CT-008/009, concurrent proposal approval | Resolved in draft; physical validation pending D02 |
| D09 | high | 2C §2.2-2.5; OpenAPI SSE placeholder | No concrete reconnect grammar in OpenAPI | False replay or stale private stream | No SSE event IDs; monotonic chunkIndex per live feed only; status reconciliation | Link grammar, add 406/cursor policy, auth bounds | C06-C16/R12 | Resolved in draft; security integration untested |
| D10 | high | 2C §3.2-3.3; Phase 1A §7 | Retry/lease policy lacks implementable bounds | Stuck/duplicate jobs and late writes | Fenced leases and bounded retry profile in state/mapping | Define relay recovery, poison policy, provider ambiguity | I11-I15/N02/N05 | Resolved as proposed engineering profile; D02 pending |
| D11 | high | 2C §2.4; API §4 | Physical sequence versus regenerated logical order ambiguous | Duplicate or reordered transcript | Logical turn cursor anchored to trigger; only latest turn regeneration | Add query/selection mapping | R07-R10; paginated regeneration | Resolved in draft |
| D12 | blocker | Phase 1A §9; API §3 privacy; SRS NFR-015/020 | Immutable revisions versus erasure; retention undecided | Private data retained indefinitely or deleted prematurely | Privileged purge bypass with lifecycle gate; policy owner approves deadlines | Document mechanics and proposed policy separately | Deletion crash/restore/storage suite | Historical: Pending Product Approval (superseded by P2D-P01–P05; see final disposition) |
| D13 | high | SRS FR-025/040; API §3; DTOs | Memory removal not contracted; research-disable was already present and is now documented correctly | Required MVP controls missing | Propose explicit tombstone command and conversation setting; retain full SRS scope | Record amendment, block contract freeze until approved | AT-024/039 | Historical: Pending Product Approval (superseded by P2D-P01–P05; see final disposition) |
| D14 | blocker | API §9.3,9.6-9.9; OpenAPI snapshot/evidence/webhook DTOs | Loose content, unresolved evidence mapping and webhook SDK contract | Unsafe or incompatible public schema | Versioned typed SnapshotContent and explicit evidence provenance; verify signed webhook adapter | Keep field-level contracts blocked until reviewed; no invented SDK details | SEC-004/CT-018/AT-035/041 | Outstanding blocker |
| D15 | medium | 2B OpenAPI common errors; inventory headers | Missing 403/428, incomplete async Location/Retry-After conventions | Clients mishandle conflicts/retries | Human contract governs; align declared responses and headers | Add conditional responses and async headers | CT-009/024 and response conformance | Resolved in draft; runtime untested |
| D16 | medium | API §1; Phase 2C contract-delta checklist | OpenAPI called source of truth; confirmed streaming choices still Proposed | Machine file silently overrides intent | Human hierarchy; mark explicit disconnect/replay decisions accepted only | Update authority/status notes | Documentation consistency review | Resolved in draft |


## Prior reinspection evidence (historical; final disposition below)

| Issue | Inspected evidence and change | Current resolution / remaining action |
|---|---|---|
| D01 | cleanup-manifest inventories all 33 original artifacts including newly supplied 1B/2A; review headers normalized, ADR-013 canonical | Inventory resolved; baseline approval owner/version/date still Open |
| D02 | physical-design §11, schema/schema.prisma and constraints/guards.sql: generic ledger model, six-state enum, cancellation-active index, leases and versions reconciled statically | Not closed: Prisma/Migrate/PostgreSQL transaction tests unexecuted; tests DB-31–37 added |
| D08 | preferencesVersion, metadataVersion, MemoryProposal.version, currentVersion, Idea/Assumption/Experiment.version and snapshot.draftRevision match API preconditions; OpenAPI/inventory updated | Resolved in draft; CAS/ETag integration untested |
| D12 | state-machines privacy lifecycle and physical-design §11 preserve privileged erasure exception; ordinary triggers still reject deletion | Historical: Pending Product Approval (superseded by P2D-P01–P05; see final disposition) for retention/backup/legal rules; privileged audited purge procedure and tombstone storage remain implementation-design blockers |
| D13 | Conversation.proactiveResearch and ConversationPatch.proactiveResearch were already present; API §11 defines admission semantics. MemoryPatch now proposes REMOVED alternative | Research discovery error corrected; memory-removal wire semantics Historical: Pending Product Approval (superseded by P2D-P01–P05; see final disposition); no silent policy change |
| D14 | API §11–12 types SnapshotContent and maps evidence provenance; security §16 references provider raw-body verifyWebhook mechanism | Partial resolution: snapshot structure Historical: Pending Product Approval (superseded by P2D-P01–P05; see final disposition); durable webhook inbox, subject tombstone and pinned event subset still block freeze |
| D07/D10 | IdempotencyRecord, job epochs/deadlines and outbox claimEpoch now modeled; usage reservation projection explicit | Logical agreement improved; safe original-response reconstruction and failure recovery require runtime proof |
| D15/D16 | Structural checks recorded in validation-report; hierarchy and owner-confirmed streaming decisions explicit | Draft consistency only; no full schema/server conformance assertion |

## Additional findings from supplied artifacts

| ID / severity | Affected section / conflict | Impact / canonical correction | Test | Status |
|---|---|---|---|---|
| D17 / high | guards.sql target_version_consistency allowed NULL expectedMemoryVersion via SQL UNKNOWN | Add explicit IS NOT NULL; absent target requires both values NULL | DB-34 | Corrected statically; unexecuted |
| D18 / high | Phase 2A §5 turned stream transport failure into terminal job outcome | SSE adapter emits stream.error/close only; fenced worker/reconciler owns terminal state | C15, I15 | Corrected in draft |
| D19 / high | Snapshot REVIEWING -> DRAFT blocked by SQL while editable-review contract permits it; snapshot ETag confused with immutable version | Permit review edit reset; ETag uses draftRevision and document version stays fixed | DB-35, CT-008/013 | Corrected statically; unexecuted |
| D20 / high | Integration matrix /messages and /memory paths incorrectly classified by substring /me | Map exact prefix to Conversation/Memory/Proposal -> Idea -> owner; never account-only | All route negative ownership tests | Corrected; static inventory verified |
| D21 / medium | Abbreviated Express ADR overlaps ADR-013; old package copy instructions create competing paths | Preserve shorter ADR as Superseded; one active ADR and canonical path index | Link/status audit | Resolved in draft |
| D22 / high | Schema default versions/lease fields are not SQL state/epoch enforcement; webhook inbox/tombstone absent | Require guarded transactions and reviewed inbox/purge physical design; do not infer safety from columns | DB-31/33/37, D2D-11 | Outstanding blocker |


## Final closure disposition — current review package

“Closed in design” alone does not imply owner approval or executed proof; explicit product and A07 approvals are recorded separately in this current table/decision log. Product-policy and implementation gates are separate. No original issue ID or evidence is erased.

| Issue(s) | Current resolution | Canonical evidence / remaining gate | Acceptance |
|---|---|---|---|
| D01 | Approval facts separated; administrative approval record ready | decision-log approval register: owner calls prior PRD/SRS/HLD approved in current request; historical revision hashes/signatures unavailable. Closure A07 approved; content manifest identifies exact working-tree revision | Historical baseline provenance A02 remains administrative |
| D02 | Closed in design; validation deferred | physical-design §12–13, schema 23 models, SQL scoped immutability DELETE predicate; real Prisma/PostgreSQL proof not executed | DB-38–42, FSEC suite |
| D03–D11 | Closed in design, prior technical corrections retained | API/OpenAPI/matrix/state machines agree; context epoch differs from execution lease epoch | Existing C/I/R, CT and DB suites |
| D12 | Closed in design and core product approval P2D-P01/P02/P03; deployment retention separate | state-machines privacy table/lifecycle/checkpoints/restore, physical §13: no trigger disable, restricted scoped purge; 30-day active-system purge target approved; backups/ancillary retention remain separate proposals | FSEC-05–08/14/15 |
| D13 | Closed in design; memory/context product decision explicitly approved P2D-P04 | API §13/15, Idea.contextEpoch/dispatchAuthorizedAt and ContextChanged fencing; existing proactiveResearch field reused | FSEC-09/10, CT-028/029 |
| D14 | Closed in design; immutable/versioned snapshots and bounded PDF exports approved P2D-P05; SDK proof deferred | security §16 supported event set/official refs, physical §12, typed SourceReference/SnapshotContent and API §14/15; no guessed provider methods | FSEC-01–04/11/12, CT-030–032 |
| D15–D21 | Closed in design; prior source/SQL/scope fixes preserved | Current reference/enum/operation checks in validation-report; ADR history retained | CT-008/009/013, DB-34/35, static checks |
| D22 | Design obligations specified; runtime/role proof deferred | entry-point/role/lease/scope contract in physical §13 and guard fragment; no application implementation written | DB-38–42, FSEC-08/13 |

No remaining unspecified Phase 2D technical mechanism is asserted as a passed runtime guarantee. Five product decisions P2D-P01–P05 (A03–A06) are explicitly approved. A07 is Approved for FL-P2D-1.0-approved; A08/O01 retain ancillary/deployment choices; provider adapter pinning, privileges, constraint races and deployment settings are implementation-stage verification gates. If a chosen provider cannot meet policy, return to owner approval rather than weakening the contract silently.


## Explicit owner product approval reconciliation

Evidence is the latest owner instruction in this conversation; no approval date, signature or runtime result supplied. P2D-P01 supersedes the old 7-day live-purge proposal with the approved proposed maximum 30-day active-system target (p2d-privacy-v2); backup/provider residuals remain distinct. P2D-P02/P03 approve fresh account-deletion authentication, immediate gating, recoverable cleanup and empty new-account recreation. P2D-P04 approves context exclusion with historical/in-flight handling. P2D-P05 approves immutable versioned snapshots and reasonable PDF bounds. D12/D13/D14 have no remaining blocker for these five product principles; deployment/provider settings and runtime V01 tests are not closed. Earlier pending entries above are historical evidence, not current approval status.


## Formal documentation sign-off

A07 is **Approved** by the project owner’s explicit instruction to record formal Phase 2D sign-off. Approved revision: **FL-P2D-1.0-approved**, identified by [content manifest](approved-revision-1.0.json). The exact documentation files are identified by SHA-256 and byte length; source Git HEAD is only the base, not an invented commit containing these uncommitted files. No approval date was supplied. A08/O01 deployment/ancillary choices and V01 runtime tests remain open without reopening documentation approval.
