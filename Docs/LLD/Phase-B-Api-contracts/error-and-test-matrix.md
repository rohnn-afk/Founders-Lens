# Founder's Lens — Phase 2B Error and Contract Test Matrix

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
