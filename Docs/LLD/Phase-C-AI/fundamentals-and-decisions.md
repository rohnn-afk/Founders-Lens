# 1. Fundamentals and architecture decisions

## The mental model
**HTTP request**: client submits an instruction; `202 Accepted` means durable work was recorded, not that the work succeeded.  
**SSE (Server-Sent Events)**: a long-lived **server → browser** HTTP response of `text/event-stream` frames. One-way, unlike WebSocket. Suitable for text/token updates. SSE is only a presentation channel, not a durable job or database.  
**AI streaming**: the model produces partial deltas while work is ongoing. Deltas are tentative; citations, cards and final response are committed only after schema/policy checks.  
**State machine**: allowed states and transitions for a generation; makes cancellation and retry races deterministic.  
**Idempotency**: repeated requests with the same logical intent return the same operation instead of duplicating the side effect. Different intent with a reused key is a conflict.  
**Retry**: repeating a failed transport attempt; safe only when the operation has a durable idempotency boundary. A retry of a model call may still incur duplicate provider cost.  
**Concurrency**: two requests/workers race to change the same record; DB constraints/conditional writes, not in-memory flags, arbitrate.  
**Cancellation**: authenticated request to stop work, subject to races; it is a request, not proof a remote provider stopped computing.

## ADR-2C decisions — recommended v1

| ID | Choice | Why / consequence |
|---|---|---|
| 2C-01 | REST `POST /messages` persists a user message + `GenerationAttempt(PENDING)` + outbox atomically, returns 202 | Durable acceptance even if worker or stream is offline |
| 2C-02 | Dedicated generation consumer(s) execute independently of API; delivery via BullMQ; ephemeral fanout via Redis Pub/Sub or equivalent adapter | Stateless API instances; no process-local session ownership; separate compute scaling. Queue and Pub/Sub are distinct mechanisms |
| 2C-03 | SSE endpoint requires Clerk Bearer auth via `fetch` streaming client; `EventSource` native API is not relied on | No session token in URL; normal bearer header; browser must implement SSE frame parsing or use audited library |
| 2C-04 | Generation continues after browser disconnect; 1 stream per session/generation as initial limit | Disconnect doesn't silently cancel paid work; clients may reconnect and get canonical status |
| 2C-05 | **No token replay guarantee in v1**; missed deltas can be lost; `GET /generations/{id}` and ordered transcript are canonical | Avoid building a durable per-token event store. Reload completed final answer instead |
| 2C-06 | SSE uses **no `id:` lines** for non-replayable events; `Last-Event-ID` unsupported (400) | Do not imply resumability; explicit contract rather than silent data loss. A reconnect starts a fresh live subscription |
| 2C-07 | Only one PENDING/RUNNING/CANCEL_REQUESTED generation per conversation; restrictive regeneration only on latest eligible turn | Avoid branching/context anomalies; status enforced via DB conditional/partial unique constraint |
| 2C-08 | Final output is canonical only after PostgreSQL transaction commits selected response and terminal state | Stream `generation.completed` only after DB commit; client refresh fetches canonical data |
| 2C-09 | Distinct operation key + `clientSubmissionId` for chat, both scoped to authenticated actor and route | Replay supported across lost 202; durable uniqueness protects after ledger expiry |
| 2C-10 | Cancellation is best effort; terminal committed completion wins if it races cancellation | Stable outcome independent of request arrival; no pretend undo of completed AI call |
| 2C-11 | Every worker transition and write is fenced by generation attempt ID, status, **lease epoch** and idea lifecycle; worker heartbeat/reconciler | Duplicate delivery or crashed leases cannot overwrite a newer result |
| 2C-12 | Backpressure, event payload size, timeouts and queue wait budgets are configured and measured | Bound memory and runaway connections; exact numerical defaults below are starter policy, tune after load tests |
| 2C-13 | Per-user/idea budgets reserved before durable job dispatch; settled against usage ledger on terminal state | Retry cannot bypass quotas; failed worker reconciliation prevents permanently stuck reservations |
| 2C-14 | No automatic regeneration or second AI attempt after ambiguous provider side effect without explicit bounded policy | At-least-once jobs may invoke external provider more than once; don't promise cost exact-once |

## What we're not building in v1
- WebSockets, durable per-token event journaling/replay, multi-user collaboration, historical thread branches, arbitrary multi-response selection after later turns, indefinite retention of event deltas, browser-visible provider chain-of-thought.
- Provider 'thinking' traces must not be streamed or retained as user-visible reasoning.

## Design quality vocabulary
- **Safety:** users never see another user's data; no duplicate durable effects.
- **Liveness:** jobs eventually settle or are marked failed after bounded retries/reconciliation.
- **Consistency:** selected response + generation completion commit as one unit.
- **Availability:** stream failures degrade to status polling; work need not stop.
- **Scalability:** API/SSE nodes are stateless; workers scale by queue concurrency subject to model quota and DB pool.
