# Founder's Lens — Phase 2B Error and Contract Test Matrix

**Status:** In Review — documentation/specification, not executed acceptance.

**Design draft — not executed.** Each test is a future contract or integration-test requirement.

## Error catalog

| HTTP | Machine code | Client action / semantics |
|---|---|---|
| 400 | VALIDATION_ERROR | Correct input; field reasons are non-sensitive. |
| 401 | UNAUTHENTICATED | Obtain valid Clerk session; never reveal resource existence. |
| 403 | ACTION_FORBIDDEN | Authenticated user lacks an action on accessible resource. |
| 404 | RESOURCE_NOT_FOUND | Absent or not owned; intentionally indistinguishable. |
| 409 | CONFLICT | Resolve current lifecycle/generation conflict. |
| 409 | IDEMPOTENCY_KEY_REUSED | Use a fresh key for different logical command. |
| 412 | PRECONDITION_FAILED | Refresh stale version and decide whether to retry. |
| 428 | PRECONDITION_REQUIRED | Send required `If-Match`. |
| 413 | PAYLOAD_TOO_LARGE | Send less content; avoid leaking infrastructure limits. |
| 415 | UNSUPPORTED_MEDIA_TYPE | Send supported JSON content-type. |
| 429 | RATE_LIMITED / QUOTA_EXCEEDED | Respect appropriate Retry-After or user quota messaging. |
| 503 | DEPENDENCY_UNAVAILABLE / PROVIDER_UNAVAILABLE | Safe bounded retry with same idempotency key where applicable. |
| 500 | INTERNAL_ERROR | Show generic error and request ID; log sanitized details server-side. |

## Required tests

| ID | Test scenario | Pass criterion |
|---|---|---|
| CT-001 | Missing, expired, forged, wrong-type Clerk token | All protected routes return 401, with zero private data access. |
| CT-002 | Foreign resource ID across each endpoint group | 404 indistinguishable from absent ID. |
| CT-003 | Valid owner but linked foreign assumption/evidence | Reject and commit no cross-idea relationship. |
| CT-004 | Unknown JSON fields, malformed IDs/enums, body too large | 400/413 with safe standardized envelope. |
| CT-005 | POST duplicate same key and payload, sequential | Same operation reference and no duplicate effect. |
| CT-006 | POST duplicate same key and payload, concurrent across API replicas | Single business effect, deterministic replay or in-progress indication. |
| CT-007 | Same key but different payload | 409 IDEMPOTENCY_KEY_REUSED. |
| CT-008 | PATCH stale If-Match | 412, no lost update. |
| CT-009 | PATCH missing required If-Match | 428, no mutation. |
| CT-010 | Concurrent generation submissions | One active generation, other explicit conflict/replay. |
| CT-011 | Client drops connection after accepted job | Status GET shows durable accepted resource; no duplicate submission. |
| CT-012 | Memory proposal approval concurrently from two clients | Only one approved revision/result; stale second request rejected. |
| CT-013 | Approved snapshot update attempt | Rejected, content hash unchanged. |
| CT-014 | Export or research worker races with idea deletion | No new data committed after deletion state transition. |
| CT-015 | Redis limiter unavailable during AI/research request | Expensive operation fails closed without provider spend. |
| CT-016 | Cursor reused with different owner/filter/sort | 400, no cross-scope pagination data. |
| CT-017 | Private route cache/proxy handling | `Cache-Control: no-store`; no cache leakage. |
| CT-018 | Raw-body webhook bad signature/replay | 401/400, no user changes. |
| CT-019 | Browser SSE using Authorization-bearing fetch | Valid stream; no token in URL, reconnect contract tested in 2C. |
| CT-020 | Disconnected SSE, final generation durable state | Status endpoint reflects actual completed/failed/cancelled state. |
| CT-021 | Error logging under malicious payload | No bearer token, founder text, stack trace or signed URL in client/logs. |
| CT-022 | Pagination 1, 25, 100, 101, malformed cursor | Stable ordering and bound enforcement. |
| CT-023 | OpenAPI request/response schemas vs implemented controllers | Zero drift; CI contract checks. |
| CT-024 | Quota exhaustion and Retry-After | Stable 429/error, no unexpected charges. |
| CT-025 | Non-owned export download-grant | 404 and no signed storage URL created. |
| CT-026 | User disabled/deleting during request | New mutations denied, in-flight worker checked before final write. |

## Evidence and acceptance

- Test artifacts later must include API test report, negative-auth coverage matrix, contract conformance output, concurrency results and redacted request samples.
- No full API approval until OpenAPI and physical schema agree on required fields, version counters and idempotency persistence.
- Targets: all contract tests pass; 100% of private route families have negative ownership tests; zero unreviewed breaking API changes.


## Reconciliation acceptance additions (not executed)

CT-027: preferences and conversation PATCH missing/stale If-Match returns 428/412; public conversation.version maps metadataVersion. CT-028: Approved P2D-P04 MemoryPatch removal excludes active context after commit, increments version, preserves history until purge and cannot be undone by a late proposal. CT-029: proactiveResearch=false blocks newly admitted automatic jobs; accepted/manual requests obey §11. CT-030: SnapshotContent rejects unknown fields/HTML rendering, excessive sections and foreign evidence; canonical hash and draftRevision agree with PostgreSQL representation. CT-031: Evidence DTO nullable provenance matches stored source fields without inventing unknown dates/geography. CT-032: Clerk raw-body bytes/svix headers verified before processing, duplicate/out-of-order delete does not resurrect identity, DB failure returns 503; design now specified; runtime proof unexecuted.


Final acceptance: [FSEC-01–16](../04-integration-review/test-acceptance-matrix.md#final-securityprivacy-closure-scenarios) covers durable webhook, recreation, deletion faults, context races, immutable exports, ownership, storage and restore. CT-032 must test 204 only after durable acceptance, 409 for reused event ID with different bytes, 400 invalid signature/instance/envelope and 503 transient persistence failure. Data-operation policy header/conditional body, freshness 403, blocked-account status-only projection and artifact-expiry 409 also require contract fixtures.


## Phase 4 controlled contract acceptance additions (not executed)

| ID | Scenario / expected invariant | Verification method / authority |
|---|---|---|
| CT-P4-01 | Submission lookup matches original attempt1,foreign/missing404,blocked lifecycle403,concurrent404 inconclusive;no paid work | Two principals/ideas,commit/read barrier,assert provider/outbox/usage unchanged;API§19.1 |
| CT-P4-02 | Cancel200/202/regenerate202 full Generation;same-key original snapshot vs current GET,terminal races unchanged | Strict DTO fixture plus DB ordering barriers;API§19.2 |
| CT-P4-03 | Default exact legacy schemas;only explicit2 exposes new read shapes;unknown selector/wrong body/foreign cursor400 | v1 andv2 strict consumers,negative query/body/page cases;API§19.3 |
| CT-P4-04 | Memory v2 actual version/text/source;null IDs for deleted/foreign/unknown source;quoted If-Match plus target check | Source authorization fixtures,two-tab accept/dismiss/atomic approvedText;API§19.4 |
| CT-P4-05 | Learning reflection legacy vs observation/interpretation2 roundtrip;no dual aliases;null legacy observation honest | Strict POST/list fixtures,immutable replay row,projection switching409;API§19.5 |
| CT-P4-06 | Experiment method/criteria read back or explicitnull for unknownJSON;do not infer title/hypothesis | Stored JSON fixtures andreload;P4-B01 remains blocker |
| CT-P4-07 | Evidence-link read scopes/paginates existing composite relationships;empty200;foreign404/cursor400,no external lookup | Two principals/assumptions,stable same-timestamp pages,delete/create relationship fixtures |
| CT-P4-08 | Session opaque record expires/clears,never text/token/grant;lookup404 never resends;P4-B02 no silent evidence loss | Browser storage tamper/copy/failure plus API call counts;nonempty unresolved evidenceIds409 |

All tests are planned/unexecuted. Static YAML/ref/header assertions do not execute schemas,Prisma,PostgreSQL,Clerk,browser/security or model behavior. Unexpected P4-B01/B02 mappings are documentation blockers, not tests marked passed.

## Approved mapping acceptance additions (all Not executed)

CT-MAP-01: validate ExperimentCreateV3 explicit title/method/hypothesis and minimal201 receipt; default1 fresh create409 versus historical accepted replay; selector2/unknown400. CT-MAP-02: strict old response1/2 schemas, nullable legacy title only in3, current stored hypothesis and no title-to-hypothesis copy. CT-MAP-03: rename/hypothesis/method isolation under If-Match, atomic version increments and unsupported legacy plan409. CT-MAP-04: learning input1/2/3 distinct-source capture, reflection versus interpretation, null observation and recorded-empty versus legacy-unknown read-back. CT-MAP-05: missing/foreign evidence404 with no partial Learning, duplicate set handling and unchanged fingerprints. CT-MAP-06: same-key receipt3 replay without private mutable fields and Learning3 membership replay after current authorization. CT-MAP-07: no ordinary marker reset or link update/delete; purge can erase under the correct scope/lease. CT-MAP-08: mixed-writer rollout, rollback data preservation, private cache cleanup and legacy-client upgrade guidance. Supplement existing MAP/F4D/DB cases; static agreement is not executed service/security proof.

## P5-AM01 acceptance - Not executed

P5-DEL-01 independent write failure: no202/primary deletion commit. P5-DEL-02 durable intent then primary failure: scope blocked and reconciled, not falsely committed. P5-DEL-03 lost202: same-key original outcome, no new operation. P5-DEL-04 duplicate/delayed mirror: immutable scope and monotonic evidence. P5-DEL-05 older restore: independent coverage before any private read. P5-DEL-06 missing/stale authority: fail closed, no negative-cache bypass. P5-DEL-07 generation/research/PDF race: current context/lease/lifecycle and suppression checks reject late effects. P5-DEL-08 new signup: new empty incarnation, old data suppressed. P5-DEL-09 corrupted digest/version/key: recovery remains closed. P5-DEL-10 partial partitions: no accepted202 without verified intent plus primary commit. P5-DEL-11 concurrent same-key: one winning operation UUID; changed payload409. API/admission, privacy reconciler, workers and restore operator own their respective invariants; verification uses fault-injected store/DB barriers, authorization fixtures and isolated restore drills. All scenarios remain Not executed; static documentation checks are insufficient.
