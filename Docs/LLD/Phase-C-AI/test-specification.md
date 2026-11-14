# 5. Contract, security, failure-injection and load test specification

**Status:** Documentation/test specification only; none executed. **Environment for implementation:** real PostgreSQL with SQL guards, Prisma migrations, Redis/BullMQ, Express instances, generation worker, deterministic fake LLM adapter, fake clock and controllable broker failures. Contract assertions cover HTTP, SSE, database rows and emitted job counts. Never use only mocks for uniqueness/concurrency verification.

## 5.1 Functional / transport

| ID | Test | Expected result |
|---|---|---|
| C01 | Submit valid chat | Exactly one user Message, one PENDING attempt, one outbox event; 202 stable refs |
| C02 | Submit invalid/malicious role or oversized content | 400/413; no DB side effects |
| C03 | Subscribe with valid Bearer token | 200 SSE stream, proper media/cache headers |
| C04 | Stream with expired token | 401 before headers; no subscription |
| C05 | Cross-tenant attempt UUID on status/stream/cancel | Privacy-safe 404; no event leak |
| C06 | Stream with `Last-Event-ID` | 400 unsupported cursor; no replay implication |
| C07 | Stream malformed Accept header | 406 before headers |
| C08 | Heartbeat through idle ingress | Comment frames; proxy keeps connection alive; no canonical status mutation |
| C09 | SSE chunks split mid-UTF8 / JSON | Parser reconstructs exactly; no corrupted rendered characters |
| C10 | Stream terminal commit success | Completed event only after DB terminal/message transaction commits |
| C11 | Connect after terminal commit | Terminal event then close; GET transcript returns selected final |
| C12 | Disconnect while running | Generation proceeds; reconnect GET status; final available |
| C13 | Reconnect while running | No claimed token replay; final replaces partial draft |
| C14 | Pub/Sub drops a middle delta | No DB corruption; provisional text may gap; final exact via transcript |
| C15 | No broker subscription possible | 503 before headers or `stream.error` after; status polling works |
| C16 | Slow SSE client | Buffer bound/disconnect, no uncontrolled memory growth |

## 5.2 Idempotency / concurrency / transaction safety

| ID | Test | Expected result |
|---|---|---|
| I01 | Same idem key + same request after lost 202 | Same messageId/generationId, original accepted status |
| I02 | Same idem key + changed content | 409, no second submission |
| I03 | Same submission ID + different idem key and matching content | Same logical user message/generation |
| I04 | Same submission ID + different content | 409, no overwrite |
| I05 | 50 concurrent identical submissions | Exactly one user Message, one initial attempt/outbox; others replay or bounded in-progress |
| I06 | Two different user messages concurrent same conversation | Exactly one accepted while attempt active, other 409 |
| I07 | Same key across two different users | Scoped correctly; no data crossover |
| I08 | Idem ledger TTL expires, same submission ID resent | Chat uniqueness still protects |
| I09 | DB commit succeeds, HTTP connection drops | Retry resolves original operation, does not call provider again |
| I10 | DB commit rolls back | No dangling message, attempt, outbox or quota reservation |
| I11 | Outbox publish succeeds, mark-published DB update fails | Duplicate dispatch possible; worker dedupes |
| I12 | Two workers claim same attempt | Only one epoch owner; stale worker cannot finalize |
| I13 | Lease expires; old model returns | Old epoch rejected; no additional final message |
| I14 | Worker retries after Redis/BullMQ job cleanup | Durable status/epoch prevents repeated business effect |
| I15 | DB commit of final fails after deltas streamed | No COMPLETED event, no canonical final; reconciler fails/retries safely |

## 5.3 Cancellation / regeneration / security

| ID | Test | Expected result |
|---|---|---|
| R01 | Cancel PENDING before worker claim | CANCEL_REQUESTED → CANCELLED, no provider invocation |
| R02 | Cancel RUNNING with abort support | Provider abort attempted; terminal CANCELLED |
| R03 | Cancel RUNNING without abort support | Late response discarded; terminal CANCELLED; cost may accrue |
| R04 | Completion CAS wins then cancellation arrives | Cancel sees COMPLETED, returns 200 current state |
| R05 | Cancellation CAS wins then completion races | Completion predicate fails; no new final message |
| R06 | Duplicate cancel with same key | Same logical cancellation, no duplicate side effects |
| R07 | Regenerate latest eligible turn | New attempt only; no duplicate user message |
| R08 | Regenerate earlier turn after later user message | 409, no historical-context mutation |
| R09 | Regeneration fails/cancels | Old selected response remains canonical |
| R10 | Regeneration completes | Exactly one selected completed response for trigger; previous retained unselected |
| R11 | Delete idea mid-generation | New status/stream access denied; late worker write prevented |
| R12 | Revoke session mid-stream | Stream closed within auth revalidation/max session bound; no new subscribed private events afterward |
| R13 | Redis unavailable at admission | Expensive work rejected or strict DB quota fallback; no unlimited admission |
| R14 | Quota reservation and reconcile | Exactly one bounded reservation per logical generation; settle/refund policy enforced |
| R15 | Malicious research/LLM output includes secrets/HTML | Event payload sanitized, no secrets/HTML execution, failed validation handled |

## 5.4 Nonfunctional and operational (targets to confirm)

| ID | Measure / test | Initial acceptance target |
|---|---|---|
| N01 | API instances scale from 1 to 3 with cross-node SSE | No lost *canonical* completion; no node-specific session dependency |
| N02 | Worker crash and recovery | Every committed attempt eventually terminal or alert within configured reconciliation window |
| N03 | SSE memory pressure | Backpressure caps enforced; no linear unbounded per-connection memory |
| N04 | Load with 100 concurrent streams (representative baseline, tune from expected usage) | No cross-tenant data, stable process memory and health; collect p95 handshake and event lag |
| N05 | Error-budget audit | Every terminal generation has coherent output/usage/outbox accounting; alert on orphaned states |
| N06 | Prompt/data confidentiality | Log inspection confirms no bearer token, prompts, founder text, full SSE data or storage URL leak |
| N07 | Cost budget injection | Duplicate provider attempts do not bypass per-user cap; externally billed duplicates documented |
| N08 | Stream idle timeout and retry | Client recovers via durable GET within policy; no repeated logical submission |

## 5.5 Traceability / approvals

- C01/I01/I10: durable chat submission + idempotency (Phase 2B; SRS durability). C03–C16: SSE/live display reliability and private session boundary (Phase 2A/2B). I05–I15: transactions/outbox/at-least-once processing (Phase 1B/HLD). R01–R10: cancellation/regeneration lifecycle (Phase 2B; Phase 3 integration). R11–R15: deletion, quota, privacy and security (SRS/HLD). N01–N08: operational readiness.
- **Gate 1 — contract:** freeze API/stream DTOs + OpenAPI; peer review security, state transitions and retry semantics.
- **Gate 2 — schema:** Prisma validate + migrate real PostgreSQL and test partial indexes, epoch checks, ledger uniqueness, deletion.
- **Gate 3 — integration:** execute every C/I/R test, separate deterministic provider fake from staging provider smoke tests.
- **Gate 4 — performance:** run load and fault injection on deployment-like environment; tune starter limits; record baseline metrics.
- **Gate 5 — release:** cost and privacy policies, provider terms, audit retention, documented operational runbooks and recovery drills.

**Approval criterion:** No unresolved ownership bypass, duplicate durable side effect, false completion, late-write-after-cancel, indefinite stuck job, or leaked sensitive data. Any waived nonfunctional target must be explicitly recorded in an ADR with operational mitigation.
