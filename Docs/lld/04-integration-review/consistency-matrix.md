# Contract consistency matrix

**Status:** Approved Phase 2D documentation — A07, FL-P2D-1.0-approved. Runtime acceptance remains unexecuted; identified deployment/ancillary proposals remain tracked.

Physical mappings below describe the proposed Phase 1B schema and outstanding obligations; none is runtime-validated. OpenAPI represents the human contract. D02/D08/D14 prevent schema/conformance sign-off.

## Complete founder operation inventory

Every listed operation requires verified Clerk session, ownership-scoped lookup, explicit DTO validation and no-store. New work/content requires active local account; the only blocked-account exceptions are minimal subject-bound deletion status and same-intent replay (API §16/security §16), never content/download. Lists authorize parent before pagination; nested references must share idea even under same owner. Reads have no side effect or idempotency key. All PATCH operations now have proposed persisted versions and required If-Match in the inventory.

| Method/path | Authorization chain | DTO | Idempotency | Concurrency |
|---|---|---|---|---|
| GET /api/v1/me | active local account | UserAccount | No ledger key; see semantics below | Lifecycle/uniqueness guard |
| PATCH /api/v1/me/preferences | active local account | UserAccount | No ledger key; see semantics below | If-Match; 428/412 |
| POST /api/v1/me/data-operations | active owner for new work; verified same-scope deletion replay only when blocked | DataOperation | Required ledger key | Lifecycle/uniqueness guard |
| GET /api/v1/me/data-operations/{operationId} | active owner for export; matching verified subject for minimal deletion status | DataOperation | No ledger key; see semantics below | Lifecycle/uniqueness guard |
| GET /api/v1/ideas | Idea -> authenticated owner | IdeaList | No ledger key; see semantics below | Lifecycle/uniqueness guard |
| POST /api/v1/ideas | Idea -> authenticated owner | Idea | Required ledger key | Lifecycle/uniqueness guard |
| GET /api/v1/ideas/{ideaId} | Idea -> authenticated owner | Idea | No ledger key; see semantics below | Lifecycle/uniqueness guard |
| PATCH /api/v1/ideas/{ideaId} | Idea -> authenticated owner | Idea | No ledger key; see semantics below | If-Match; 428/412 |
| DELETE /api/v1/ideas/{ideaId} | Idea -> authenticated owner | DataOperation | No ledger key; see semantics below | Lifecycle/uniqueness guard |
| GET /api/v1/ideas/{ideaId}/conversations | Idea -> authenticated owner | ConversationList | No ledger key; see semantics below | Lifecycle/uniqueness guard |
| POST /api/v1/ideas/{ideaId}/conversations | Idea -> authenticated owner | Conversation | No ledger key; see semantics below | Lifecycle/uniqueness guard |
| GET /api/v1/conversations/{conversationId} | Conversation -> Idea -> owner | Conversation | No ledger key; see semantics below | Lifecycle/uniqueness guard |
| PATCH /api/v1/conversations/{conversationId} | Conversation -> Idea -> owner | Conversation | No ledger key; see semantics below | If-Match; 428/412 |
| GET /api/v1/conversations/{conversationId}/messages | Conversation -> Idea -> owner | MessageList | No ledger key; see semantics below | Lifecycle/uniqueness guard |
| POST /api/v1/conversations/{conversationId}/messages | Conversation -> Idea -> owner | MessageSubmission | Required ledger key | Lifecycle/uniqueness guard |
| GET /api/v1/generations/{generationId} | Attempt -> Conversation -> Idea -> owner | Generation | No ledger key; see semantics below | Lifecycle/uniqueness guard |
| GET /api/v1/generations/{generationId}/events | Attempt -> Conversation -> Idea -> owner | EventStream | No ledger key; see semantics below | Lifecycle/uniqueness guard |
| POST /api/v1/generations/{generationId}/cancel | Attempt -> Conversation -> Idea -> owner | Generation | Required ledger key | Lifecycle/uniqueness guard |
| POST /api/v1/conversations/{conversationId}/regenerations | Conversation -> Idea -> owner | Generation | Required ledger key | Lifecycle/uniqueness guard |
| GET /api/v1/ideas/{ideaId}/memory | Idea -> authenticated owner | MemoryList | No ledger key; see semantics below | Lifecycle/uniqueness guard |
| GET /api/v1/ideas/{ideaId}/memory-proposals | Idea -> authenticated owner | ProposalList | No ledger key; see semantics below | Lifecycle/uniqueness guard |
| PATCH /api/v1/memory-proposals/{proposalId} | active local account | MemoryProposal | No ledger key; see semantics below | If-Match; 428/412 |
| POST /api/v1/memory-proposals/{proposalId}/accept | active local account | ConfirmedMemory | Required ledger key | If-Match; 428/412 |
| POST /api/v1/memory-proposals/{proposalId}/dismiss | active local account | MemoryProposal | Required ledger key | If-Match; 428/412 |
| PATCH /api/v1/memory/{memoryId} | active local account | ConfirmedMemory | No ledger key; see semantics below | If-Match; 428/412 |
| GET /api/v1/memory/{memoryId}/revisions | active local account | MemoryRevisionList | No ledger key; see semantics below | Lifecycle/uniqueness guard |
| GET /api/v1/ideas/{ideaId}/assumptions | Idea -> authenticated owner | AssumptionList | No ledger key; see semantics below | Lifecycle/uniqueness guard |
| POST /api/v1/ideas/{ideaId}/assumptions | Idea -> authenticated owner | Assumption | No ledger key; see semantics below | Lifecycle/uniqueness guard |
| PATCH /api/v1/assumptions/{assumptionId} | Assumption -> Idea -> owner | Assumption | No ledger key; see semantics below | If-Match; 428/412 |
| GET /api/v1/ideas/{ideaId}/experiments | Idea -> authenticated owner | ExperimentList | No ledger key; see semantics below | Lifecycle/uniqueness guard |
| POST /api/v1/ideas/{ideaId}/experiments | Idea -> authenticated owner | Experiment | Required ledger key | Lifecycle/uniqueness guard |
| PATCH /api/v1/experiments/{experimentId} | Experiment -> Idea -> owner | Experiment | No ledger key; see semantics below | If-Match; 428/412 |
| POST /api/v1/experiments/{experimentId}/learnings | Experiment -> Idea -> owner | Learning | Required ledger key | Lifecycle/uniqueness guard |
| GET /api/v1/ideas/{ideaId}/learnings | Idea -> authenticated owner | LearningList | No ledger key; see semantics below | Lifecycle/uniqueness guard |
| GET /api/v1/ideas/{ideaId}/evidence | Idea -> authenticated owner | EvidenceList | No ledger key; see semantics below | Lifecycle/uniqueness guard |
| GET /api/v1/ideas/{ideaId}/research-jobs | Idea -> authenticated owner | ResearchJobList | No ledger key; see semantics below | Lifecycle/uniqueness guard |
| POST /api/v1/ideas/{ideaId}/research-jobs | Idea -> authenticated owner | ResearchJob | Required ledger key | Lifecycle/uniqueness guard |
| GET /api/v1/research-jobs/{researchJobId} | ResearchJob -> Idea -> owner | ResearchJob | No ledger key; see semantics below | Lifecycle/uniqueness guard |
| POST /api/v1/assumptions/{assumptionId}/evidence-links | Assumption -> Idea -> owner | EvidenceLink | No ledger key; see semantics below | Lifecycle/uniqueness guard |
| DELETE /api/v1/assumptions/{assumptionId}/evidence-links/{evidenceId} | Assumption -> Idea -> owner | 204 empty | No ledger key; see semantics below | Lifecycle/uniqueness guard |
| GET /api/v1/ideas/{ideaId}/snapshots | Idea -> authenticated owner | SnapshotList | No ledger key; see semantics below | Lifecycle/uniqueness guard |
| POST /api/v1/ideas/{ideaId}/snapshots | Idea -> authenticated owner | DocumentSnapshot | Required ledger key | Lifecycle/uniqueness guard |
| GET /api/v1/snapshots/{snapshotId} | Snapshot -> Idea -> owner | DocumentSnapshot | No ledger key; see semantics below | Lifecycle/uniqueness guard |
| PATCH /api/v1/snapshots/{snapshotId} | Snapshot -> Idea -> owner | DocumentSnapshot | No ledger key; see semantics below | If-Match; 428/412 |
| POST /api/v1/snapshots/{snapshotId}/approve | Snapshot -> Idea -> owner | DocumentSnapshot | Required ledger key | If-Match; 428/412 |
| POST /api/v1/snapshots/{snapshotId}/exports | Snapshot -> Idea -> owner | ExportJob | Required ledger key | Lifecycle/uniqueness guard |
| GET /api/v1/exports/{exportId} | ExportJob -> Snapshot -> Idea -> owner | ExportJob | No ledger key; see semantics below | Lifecycle/uniqueness guard |
| POST /api/v1/exports/{exportId}/download-grant | ExportJob -> Snapshot -> Idea -> owner | DownloadGrant | No ledger key; see semantics below | Lifecycle/uniqueness guard |

Additional operations: GET /health/live public process-only; GET /health/ready ingress-restricted/minimal response; POST /webhooks/clerk uses raw-body signature, freshness and event-ID deduplication (no founder bearer substitution). All are excluded from founder ledger. SDK event contracts remain D14. 48 founder operations plus 3 exceptions; unique method/path required.

## Persistence, runtime and worker mapping

| Domain | Required persistence/constraints | API contract | Stream / worker |
|---|---|---|---|
| Account | unique clerkSubject; local immutable ID; lifecycle; preferencesVersion | /me derived from verified subject only; reject supplied user IDs | Queue only local IDs; reauthorize before every sensitive final commit |
| Ideas | owner fixed; lifecycle; integer version | owned CRUD; versioned edit; DELETE async DataOperation | Lifecycle lock serializes deletion with commits |
| Conversation | fixed idea; nextSequence; metadataVersion | title/settings update versioned; proactiveResearch exists in schema and API; false blocks new automatic research | One active attempt per conversation |
| Message / attempt | unique conversation+clientSubmissionId and semantic hash; unique sequence; trigger/response same conversation; one response per attempt; one selected COMPLETED per trigger; active partial uniqueness over PENDING/RUNNING/CANCEL_REQUESTED | Flat MessageSubmission; six-state Generation | SSE grammar Phase 2C §2.2; epoch/lease/deadline guarded writes |
| Replay ledger | unique actor+operation+authorized target+key; fingerprint+algorithmVersion; original HTTP response/status and safe refs; expiration | Reauthorize before replay; conflicting payload 409 | No queue/cache second authority; replays resolve before current version predicates |
| Memory | proposal.version; memory.currentVersion; revision unique memory+version; target expectedVersion; same-idea provenance | approve/edit/dismiss require If-Match; append revision atomically | Worker may propose only; never approve |
| Assumption / experiment | own integer version; composite same-idea references | versioned PATCH; experiment transitions user-authorized | Evidence link unique assumption+evidence (pair); identical create returns existing, different relationship explicit conflict; DELETE link idempotent no-op |
| Learning / evidence | immutable append with provenance; same-idea experiment reference; dedupe per job+claim+source, not URL alone | observations/interpretations distinct; no arbitrary trust setter | Research conditional finalization atomically inserts evidence; source checked is not confirmed memory |
| Snapshot | version (document); draftRevision (edit CAS); schemaVersion/contentSha256; approved immutable except purge | edit/approve If-Match uses draftRevision; export only approved | Validate content and preserve source/unknown labels; no postapproval AI rewrite |
| Export | snapshotId+hash; attempt epoch/lease; artifact key/checksum | 202 job; status polling; owner-checked fresh grant | Retry upload safely; orphan cleanup; no expired URL replay |
| Outbox | typed payload; stable event ID; status (including FAILED poison state), nextAttemptAt, claimEpoch, leaseUntil, dispatchAttempts, lastErrorCode | Never public; committed with origin state | Claim short tx; publish outside tx; mark dispatched only with claim epoch; redis outage retries |
| Usage | reservationId unique per operation; bounded reservation/settlement state | Gate expensive admission atomically | Settle exactly once; ambiguous provider cost may require reconciliation |
| DataOperation | account/idea target, lifecycle, checkpoints, opaque cleanup manifest | 202 durable status; approved subject-bound minimal deletion-status exception; provider revocation may prevent authentication | Purge exception to immutability; no late recreation |

## Replay and mutation rules

A successful business mutation and its ledger outcome commit together. Same scoped key/fingerprint returns original accepted status/body and stable IDs, not newly computed status. GET gives current state. Reauthorize before replay, then replay before If-Match comparison to avoid rejecting an already successful command. Rollback/pre-admission validation/auth/quota failures are not accepted ledger outcomes. IN_PROGRESS is transactionally serialized; bounded lock timeout returns 409 REQUEST_IN_PROGRESS and Retry-After. A server crash before commit leaves no accepted intent; unknown commit resolves by same key, never speculative provider invocation. FAILED_REPLAYABLE only represents a durable recorded command outcome; async job failure does not replace original 202. Same submission ID with new key/content match binds new ledger to existing original attempt; mismatch 409. Expired keys for non-chat commands may represent new intent: UI must GET first if unsure; 14-day ledger retention remains a separate A08 proposal, not part of the approved active-data/purge decision. Purge removes private ledger refs.

All PATCH and reviewed decisions need own persisted integer version, including preferences and conversation metadata (now modeled in schema and OpenAPI). Idea, proposal, memory, assumption, experiment and snapshot flags already require versions. Allocate/increment in same guarded transaction; missing If-Match 428, malformed 400, stale 412, invalid lifecycle 409. Refresh and ask user to reconcile; never silently overwrite or auto retry changed intent. Snapshot draftRevision and document version must not be conflated. Non-keyed create conversation/assumption currently has no transport duplicate guarantee: recommended generic-ledger extension is a separate future proposal, not an unresolved approval of memory or research controls. DELETE idea is lifecycle-idempotent and returns existing purge operation; link DELETE repeats 204. Fresh download grants are deliberately not ledger-replayed. Memory removal via PATCH is approved under P2D-P04; proactiveResearch is already contracted.

## Worker recovery profile (proposed, unmeasured)

Every job family uses epoch, leaseUntil, lastHeartbeatAt and deadlineAt. Proposed heartbeat 10s, lease 30s, reconciler scan 15s; clock authority PostgreSQL. Renew/check at provider boundaries and before final commit; stale epoch rejects all writes. Account/idea checks are in final transaction, not solely at claim. Deadline always caps retries. Generation execution target 120s; other job deadlines require adapter-specific limits before release.

Relay claims pending or expired-claim rows with SKIP LOCKED; increment claimEpoch, publish stable event/job ID, mark dispatched conditionally. Crash after publish before mark causes duplicate delivery, safe by DB job state. Redis job retention is no business dedupe guarantee. Reconciler also detects dispatched jobs missing execution after queue loss and republishes safe intents; ambiguous running provider work fails rather than blindly repeating. Redis Pub/Sub failures lose only live fragments; polling recovers durable outcome.

Proposed relay 10 attempts exponential 1s to 60s with jitter; worker pre-invocation 3 attempts within deadline; final DB commit 3 attempts while lease valid. Exhaustion persists failed/poison reason and alerts, no indefinite active work. Operations re-drive requires authorization, recorded reason, current lifecycle and epoch; terminal generation is never reopened. Post-invocation ambiguous model calls default to FAILED; output repair disabled until explicit bounded cost policy. Research/export retry only safe adapters; rendering same approved content is safe, duplicate uploads cleaned. Usage reservation release/charge is once per intent; unknown provider charges flagged, not fabricated as zero. These numbers require configuration and fault/load validation before production.

## Security integration summary (canonical detail in Phase 2A)

Express order: trusted proxy/TLS and correlation, CORS allowlist/bounded parsing (raw webhook branch before JSON), verified Clerk session, active local mapping, distributed limits, strict Zod, ownership/lifecycle, short use-case transaction, projected response/error. Verify issuer, signature, expiry, intended authorized party/session token type with pinned SDK. No token or client userId in queue/URLs. 401 invalid credentials; 403 accessible object action forbidden/disabled local account; 404 foreign/missing object; deleting idea inaccessible. Workers operate as restricted system actors on stored local owner identity, never saved bearer tokens. Check local lifecycle at each sensitive commit; local gate wins over Clerk outage. Long streams expire no later than token expiry/hard limit, recheck account/idea every proposed 15s and close on lifecycle signal; revocation detection bound requires SDK proof. Reconnect reauthenticates. Never claim instantaneous remote revocation.

## Streaming limits and ordering

Phase 2C event names/payloads remain canonical. No id lines, no durable monotonic event-ID guarantee. chunkIndex increases per ephemeral live feed; reconnect resets feed and may miss fragments. Client deduplicates terminal notifications and fetches DB. Subscribe then read status, poll periodically to catch lost terminal Pub/Sub. Heartbeats 15s; event 16KiB, buffer 64KiB or 128 events, stream 5min are proposed caps; disconnect slow consumers, generation continues. At most one active generation per conversation, distributed account stream cap required. Last-Event-ID 400, incompatible Accept 406, broker unavailable 503. Final event only after commit.

Regeneration latest eligible user turn only; all attempts retained; successful transaction replaces selected response, failed/cancelled attempt leaves prior selected success. Physical assistant sequence is append-only; logical transcript sorts by trigger user sequence with USER then selected ASSISTANT. Cursor binds conversation/turn+slot, not later physical assistant sequence. Regeneration changes only latest turn projection; refresh that turn after terminal. Historical pages do not branch or expose unselected output as authoritative. Proposed API §4 amendment; test cursor traversal across regeneration.


## Current static evidence and outstanding gaps

[Physical schema](../01-database/schema/schema.prisma) now has 23 proposed models, CANCEL_REQUESTED, lease fields, generic ledger and proposal/conversation/preferences versions. [SQL guards](../01-database/constraints/guards.sql) include cancellation in active uniqueness and explicit non-null target-version checking. Physical snapshot names are version/draftRevision/schemaVersion/contentSha256; API mapping above uses these names. UsageLedger reservation/current settlement is mutable until one terminal settlement, then immutable. Outbox claimEpoch is distinct from job leaseEpoch. No field alone proves fenced execution or account lifecycle locking. D12/D14 designs are specified below; owner policies and runtime tests remain outstanding.


## Final closure additions (authoritative over earlier pending-design notes)

| Contract | PostgreSQL / constraints | Express API | Stream/worker authority / tests |
|---|---|---|---|
| Account/idea lifecycle | Root status DELETION_REQUESTED/PURGING/DELETED; DataOperation.deletionState survives hard removal; scoped deletionScopeKey unique | Existing delete/data-operation paths, policy acknowledgment and fresh auth; narrow status-only exception never grants business reads | Privacy coordinator fences all late jobs, DB scanner works without Redis; FSEC-05–08/13–15 |
| Durable Clerk event | WebhookInbox unique(provider,instance,eventId), body hash, status and lease; IdentityTombstone independent of account FK | Verified raw-body endpoint; user.deleted gates in acceptance tx; 204 durable acceptance, 409 payload conflict, 503 rollback | Supported created/updated/deleted hints never provision/reactivate; fresh live authenticated subject provisions; FSEC-01–04 |
| Scoped immutable DELETE | INVOKER guard checks purge owner, op/epoch/lease/PURGING and row idea; bounded DEFINER entry-point contract in physical §13 | Ordinary users cannot bypass triggers or use custom-GUC as permission | Restricted privacy worker only; no approved revision UPDATE bypass; DB-40 |
| Memory/context exclusion | currentVersion and immutable tombstone revision, Idea.contextEpoch, GenerationAttempt.contextEpoch/dispatchAuthorizedAt | Versioned MemoryPatch; only owner review confirms memory; no restore command | Context builder compares epoch before dispatch and finalization; stale result FAILED CONTEXT_CHANGED; FSEC-09/10 |
| Snapshot/citation and artifacts | Json typed content with embedded SourceReference, document version vs draftRevision, hash, artifactState/expiresAt | Validated approval/fresh download grants; historical citations never silently updated | Finalize only on active roots/epoch/hash; expire artifact separately from COMPLETED execution; FSEC-11/12/14 |
| Research control/evidence | Conversation.proactiveResearch, metadataVersion; claim provenance/same-idea links | Existing setting false blocks new automatic admission; manual/accepted jobs continue unless deletion | Delete parent purges evidence/links/snapshots, never unrelated idea; FSEC-06/14 |
| Retention/export/restore | Minimal retained DataOperation/IdentityTombstone; bounded DELETE/EXPORT checkpoint; external private suppression receipt mirror | Policy version and truthful live purge/backup residual; transient export download only active owner | Approved periods/config required before activation; restore gated on latest suppression coverage; FSEC-15/16 |

Proposed total 23 models (not an executed migration). HMAC subjectKeyVersion is separate from leaseEpoch, contextEpoch, draftRevision and content schemaVersion. No client may set any worker/identity ownership field. Detailed retention values have one owner in state-machines; this matrix deliberately links rather than restates periods.
