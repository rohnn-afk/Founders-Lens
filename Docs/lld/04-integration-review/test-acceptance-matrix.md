# Test acceptance matrix

**Status:** Approved Phase 2D documentation — A07, FL-P2D-1.0-approved. Runtime acceptance remains unexecuted; identified deployment/ancillary proposals remain tracked.

All scenarios **Not executed**. Documentation structural checks are separate from runtime acceptance. Use real PostgreSQL migrations/constraints and Redis/BullMQ, deterministic fake providers, controllable clocks/faults and two API/worker replicas. Record fixture, expected/actual DB rows, status/headers, queue effects and sanitized evidence. Existing Phase 2B CT-001–026 and Phase 2C C/I/R/N suites remain required.

| ID | Area | Acceptance oracle | Status |
|---|---|---|---|
| D2D-01 | Authentication/ownership | All 48 routes: invalid token 401; foreign resource 404; same-owner cross-idea link rejected; zero provider calls | Not executed |
| D2D-02 | Replay | Lost 202, same/new key submission duplicates, payload conflict, expired ledger, concurrent replicas and commit uncertainty: one durable effect | Not executed |
| D2D-03 | Cancellation races | Force both CAS orders for cancel/completion/failure; terminal immutable; no late selected output | Not executed |
| D2D-04 | Worker fencing | Crash/expire lease; duplicate queue delivery and old result: only current epoch commits | Not executed |
| D2D-05 | Outbox recovery | Crash before/after publish and Redis loss: redispatch safe; poison persists/alerts; no indefinite pending | Not executed |
| D2D-06 | SSE recovery | Drop deltas/terminal, reconnect, slow consumer, fragmented UTF-8, token expiry: no replay promise; exact final fetched | Not executed |
| D2D-07 | Versioning | Each mutable resource two concurrent versions: one winner, 412 stale, 428 missing, rollback no increment; successful replay precedes stale check | Not executed |
| D2D-08 | Memory | Dismiss/approve race, stale target, edited accept, transaction rollback: no AI approval, exactly one revision | Not executed |
| D2D-09 | Evidence | Forged/unknown source, missing time/scope, contradictory evidence, user report: no false verified facts or cross-idea joins | Not executed |
| D2D-10 | Snapshot/export | Approved edit denied; parity across retries; upload before DB failure; checksum mismatch; expired/foreign download denied | Not executed |
| D2D-11 | Privacy | Deletion during each worker stage; DB/storage/Clerk outage; backup restore and stale webhook: inaccessible immediately, eventual purge without resurrection | Not executed |
| D2D-12 | Quotas/logs | Concurrent reservation/duplicate settle, dependency outage, malicious prompt: bounded spend, no private logs | Not executed |
| D2D-13 | Requirements gaps | AT-024 memory delete and AT-039 research disable work after D13 contracts approved | Not executed |
| D2D-14 | Contract structure | All methods/path unique; refs resolve; server prefix once; auth/header/response schemas and route inventory agree | Not executed |

Security, false completion, lost update, privacy resurrection and duplicate durable effects are release blockers. AI quality, accessibility and latency require SRS evaluation/load/browser suites, not only fake-provider tests. Gate owner records exceptions explicitly; physical constraints cannot be proven by schema parsing.


## Final security/privacy closure scenarios

All following tests are **Not executed**. Run against pinned Clerk fixtures, disposable real PostgreSQL roles/migrations, two API/worker instances, Redis fault controls and private versioned-storage test adapter. Assert both API results and persisted effects; mocks alone do not prove SQL scope/constraints. Approval register P2D-P01–P05 records core product approval; A08/O01 identifies remaining deployment/ancillary settings before beta.

| ID | Scenario | Expected invariant | Responsible component | Verification method |
|---|---|---|---|---|
| FSEC-01 | Duplicate Clerk delivery | One inbox/event outcome and one local effect; same ID/different bytes 409; original 204 only after acceptance | Webhook adapter + inbox transaction | Parallel signed fixtures across two API instances; assert unique rows/outbox/deletion count |
| FSEC-02 | Out-of-order account events | Created/updated hints never provision or reactivate; old hints ignored; deletion dominates | Identity synchronization service | Deliver permutations/equal timestamps/delete-first barriers; inspect local status and watermarks |
| FSEC-03 | Deleted account receives old webhook | Tombstone independent of erased account; delayed signed retry cannot recreate or regain access, including after inbox TTL | Webhook admission + provisioning guard | Purge account, retain marker, replay fixtures with refreshed delivery signature; assert zero new UserAccount/provider spend |
| FSEC-04 | Authorized account recreation | Fresh verified live new subject creates empty new local UUID; email matching never relinks; old/same subject blocked | Clerk adapter + local principal service | Two subject fixtures same email, stale old token and provider outage; assert new owns no old ideas and old fails |
| FSEC-05 | Deletion during AI generation | Deletion gate first prevents final result/selection/proposal; completion first is history subsequently purged | API lifecycle transaction + generation worker | Barrier both commit orders; assert context/lease fence, no postgate commit and no false completed SSE |
| FSEC-06 | Deletion during research | No evidence/links attach after gate; provider response discarded; terminal/cost reconciliation accurate | Research worker + privacy coordinator | Pause retrieval before final DB tx, delete root, return data; assert no resurrection |
| FSEC-07 | Redis outage during deletion | Immediate DB access gate and inbox accepted; durable scanner progresses without queue; no active data access | API + outbox dispatcher + DB privacy scanner | Disable Redis at acceptance/dispatch, replay and restore; assert one operation and checkpoint progression |
| FSEC-08 | DB failure midpurge | Committed batch stays deleted, rolled-back batch stays pending, checkpoint/lease prevent skipped scope; ordinary role cannot bypass guards | Privacy worker + scoped DB purge entry point | Kill DB/worker at each phase and lease expiry; role/epoch/scope negative tests; rerun until exact scoped deletion |
| FSEC-09 | Memory removal during context construction | Old epoch cannot authorize a new dispatch; rebuild excludes REMOVED; already authorized in-flight result fails final context check | Memory service + context builder + generation worker | Barrier capture -> remove -> dispatch; assert no provider call from obsolete context; second barrier after dispatch verifies CONTEXT_CHANGED/no stale proposal commit |
| FSEC-10 | Concurrent memory approvals | Exactly one approval/revision, one current version and context epoch; dismissed/removed target never silently approved | Memory application transaction + DB constraints | Two clients/keys and same-key replay, target-change and dismiss races; check 412/409 and atomic rows |
| FSEC-11 | Edit already approved snapshot | Content/hash/schema/document version frozen; edit gets 409; fork new draft; purge DELETE only narrowly authorized | Document service + immutable guards | Raw ordinary UPDATE/DELETE and API PATCH fail; approved hash unchanged; cross-idea reference rejected |
| FSEC-12 | Retry failed PDF export | Same key replays original job; new key creates new job from same approved hash; stale upload cannot replace a valid artifact | Export API/worker + storage janitor | Inject renderer/upload/commit failures and old epoch completion; compare approved content/citations and checksums |
| FSEC-13 | Cross-user resource access | Foreign IDs always 404; disabled status exception cannot read content/download; privacy worker scope cannot select another owner | Every API repository + DB privilege guard | ID substitution across all 48 founder operations, raw SQL with API/worker/purge roles; verify zero private payload/object URL |
| FSEC-14 | Deleted information remains in storage | No false DELETED while versions/multipart/late uploads/provider duties unresolved; repeated absence checks; grant residual disclosed | Privacy worker + object adapter | Fake versioned bucket with upload-after-first-list, network fault, retention lock and orphan; require second pass/attention then assert all owned versions absent |
| FSEC-15 | Backup restore contains deleted data | No restored service opens without latest suppression coverage; reapply gates/purge and tombstones; incomplete watermark fails closed | Restore operator + privacy reconciliation | Restore predelete backup, load later receipt mirror/WAL, attempt old IDs/session/object grants; missing manifest/key or accepted-request gap keeps service isolated |
| FSEC-16 | Retention/expiry and account export | No hardcoded promise before policy approval; cutoff manifest consistent/owned; EXPIRED artifact cannot download; policy TTL respects incomplete work | Policy config + export worker + janitor | Fake-clock expiry, inactive policy 409, 20MiB cap, content-cutoff changes, privacy interruption and receipt horizon tests |

No FSEC result is “passed” merely because an expected outcome is written here. Record fixture versions, policy version, role grants, migration hash, event receipt IDs, fault timing, actual row/object counts and sanitized output. Invalid webhook signature/freshness, unknown instance, unknown event type and retention expiry also require negative fixtures. Provider request revocation cannot be proved by fake adapters alone.


## Approved-decision checks (not executed runtime tests)

P2D-P01: derive p2d-privacy-v2 activePurgeTargetAt=requestedAt+30 days; retries never reset it, overdue work alerts without restoring access, and backupResidualUntil is independent. P2D-P02/P03: verify fresh account deletion, immediate deny, replay/recovery and new empty account without old data. P2D-P04: retain context-epoch race, historical conversation/snapshot and in-flight fixtures. P2D-P05: test 1 MiB canonical content, 10 MiB PDF, 60-second deadline, two active PDF-export admissions per account concurrently, and five-minute grants; approved content/hash must never be truncated/rewritten to meet a bound. Account-export ZIP/20 MiB capture is a separate A08 proposal.
