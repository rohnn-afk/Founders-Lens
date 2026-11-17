# Founder's Lens — Database integration test matrix

**Status:** In Review — documentation/specification, not executed acceptance.

**Target**: ephemeral PostgreSQL 15+ using the same Prisma + SQL migrations deployed in production; real DB transactions, not mocks.

| ID | Test | Expected database result / API semantics |
|---|---|---|
| DB-01 | Create two accounts, cross-read other account's idea with known UUID | Authorization returns privacy-preserving 404; no leaked content |
| DB-02 | Same conversation/key sent concurrently from multiple API instances | Exactly one USER Message, one first attempt; retry returns same operation |
| DB-03 | Two different keys sent concurrently to same conversation | Exactly one active attempt, loser conflict, no consumed sequence for rejected request |
| DB-04 | Two completed regenerations for the same trigger | Two attempts, one user message; selection swap atomic; exactly one selected |
| DB-05 | Concurrent selection swap under row locks | Only eligible latest-turn completion with current epoch replaces selection; no simultaneous selected rows |
| DB-06 | Assistant response references attempt in another conversation | Composite FK rejects insert |
| DB-07 | Evidence/assumption link across different ideas | Composite FK rejects link |
| DB-08 | Experiment links assumption in another idea | Composite FK rejects insert |
| DB-09 | Learning links experiment in another idea | Composite FK rejects insert |
| DB-10 | Research job uses message from another idea | Composite FK rejects insert |
| DB-11 | Reject memory proposal, retry approval | Neither confirmed memory nor revision created |
| DB-12 | Two editors approve same target expected version | One winner; other conflict; no dropped revision |
| DB-13 | Mutate/delete MemoryRevision | DB trigger rejects |
| DB-14 | Mark evidence SOURCE_CHECKED without external locator/retrieval date | Check constraint rejects |
| DB-15 | Use URL alone as unique identity for two different findings | Distinct per-claim fingerprints allowed; same fingerprint deduped |
| DB-16 | Edit approved snapshot or replace content hash | DB trigger rejects |
| DB-17 | Export approved version after editing current idea | Export bytes derive only from approved content/hash |
| DB-18 | Create export for unapproved snapshot | Service transaction rejects; no outbox event |
| DB-19 | Research job commit + outbox publication crash boundary | Job & outbox persist; replay publication idempotent |
| DB-20 | Worker retry after idea status DELETION_REQUESTED | No new evidence or artifact completion writes |
| DB-21 | Redis unavailable after committed job/outbox | Job survives; publisher resumes after recovery |
| DB-22 | Cancel generation vs completing response | One terminal outcome; no assistant COMPLETED message on cancelled attempt |
| DB-23 | Failed memory approval transaction midway | Proposal remains unreviewed; no orphan revisions/audit commits |
| DB-24 | Account deletion and audit retention policy | Only disclosed minimal metadata remains; stored documents and backups follow approved policy |
| DB-25 | `prisma migrate deploy` from empty database | Tables, FKs, partial unique indexes, CHECKs and triggers present |
| DB-26 | Schema diff/drift after production-like migrate | No surprise dropped SQL-only constraints |
| DB-27 | Migration rollback drill / PITR restore exercise | Known recovery sequence and RPO/RTO measured, not assumed |
| DB-28 | Seed 100k messages, execute indexed history query | EXPLAIN ANALYZE shows bounded pagination and expected index usage |
| DB-29 | All queries scoped to idea/account | Automated repository guard tests / property tests on ID substitutions |
| DB-30 | Repeated usage event with same reconciliation key | One ledger row, no double charging |

**Concurrency approach**: launch 20–100 genuinely concurrent requests with shared keys and independent Prisma connections; assert exact row counts and state invariants afterwards. Use deterministic barriers and retry tests for deadlock/serialization failures.

**Expected migrations**: generate DDL via Prisma Migrate for table structure; incorporate `constraints/guards.sql` as reviewed SQL in the generated migration before applying. Run the exact same migrations in CI and staging. Do not use `prisma db push` for deployed environments.


## Reconciliation additions (not executed)

DB-31: CANCEL_REQUESTED retains active-generation uniqueness until terminal; stale worker epoch cannot finalize. DB-32: proposal, preferences and conversation version CAS returns 428/412; snapshot draftRevision distinct from document version. DB-33: generic ledger scope/fingerprint/crash/expiry and original-response replay agrees with chat domain uniqueness. DB-34: targetMemoryId plus NULL expectedMemoryVersion rejected (SQL CHECK must not pass UNKNOWN). DB-35: review preview may return REVIEWING -> DRAFT; approved content stays immutable. DB-36: memory REMOVED immediately excluded from future AI context; research disabled prevents newly admitted automatic research; lifecycle decisions in API contracts. DB-37: usage reservation settled/released once under retries, no duplicate cost reconciliation.


## Final closure database acceptance (not executed)

| ID | Expected database invariant | Acceptance scenario |
|---|---|---|
| DB-38 | Webhook unique provider/instance/event claim and hash mismatch handling; duplicate inbox delivery one deletion operation | FSEC-01/02 |
| DB-39 | Independent tombstone/receipt survive account FK removal; absent-subject advisory lock serializes provisioning/deletion; same subject blocked | FSEC-03/04 |
| DB-40 | Purge role/epoch/lease/scope predicate authorizes only DELETE for the operation; no API/custom-GUC/search_path bypass, revision UPDATE always denied | FSEC-08/11/13 |
| DB-41 | Lifecycle status mirrors DataOperation.deletionState atomically; nullable accountId SET NULL, deletionScopeKey uniqueness, resumable checkpoint and account/idea overlap | FSEC-05–08/14/15 |
| DB-42 | Memory currentVersion+Idea.contextEpoch and GenerationAttempt dispatch/final epoch comparisons serialize correctly; artifactState differs from execution outcome | FSEC-09/10/12/16 |


## Phase 4 projection/mapping acceptance (planned, unexecuted)

DB-P4-01: original Message.clientSubmissionKey lookup maps first triggering attempt,not latest regeneration;concurrent absent read never permits resend. DB-P4-02: owner/same-idea source/evidence-link reads disclose no foreign/deleted data and paginate stable createdAt/evidenceId ties. DB-P4-03: nullable Learning.observation and separate interpretation persist/reload/replay without duplicating/inventing legacy data. DB-P4-04: plan.method/JSON-string successCriteria map or returnnull for unsupported legacy JSON; Experiment.title/hypothesis mapping P4-B01 must be approved before full create/edit acceptance. DB-P4-05: nonempty Learning.evidenceIds has no approved physical relationship (P4-B02); verify fail-closed409 until controlled mapping selected,never assert accidental AssumptionEvidence side-effects. No migrations/SQL/Prisma validation executed; models/guards are unchanged by these projection amendments.

## Approved mapping database acceptance (all Not executed)

DB-MAP-01: plan.title/method merge without changing hypothesis or unrelated keys; nonnullable hypothesis on every accepted new row. DB-MAP-02: LearningEvidence composite PK and both same-idea FKs reject duplicate/foreign membership; evidence/learning IDs are not authorization. DB-MAP-03: false historical marker remains unknown, true new empty set is authoritative, partial insert failures roll back Learning/links/receipt together. DB-MAP-04: SQL parent locking/count bounds, initial-only capture service rule and replay races. DB-MAP-05: ordinary Learning/link UPDATE/DELETE rejected, scoped purge removes links before parents, wrong scope/epoch/role denied. DB-MAP-06: generated migration preserves old rows, NOT VALID JSON check and no fabricated backfill, mixed-writer admission gated, populated associations retained on rollback. DB-MAP-07: deleted data restored from old backup stays inaccessible under existing watermark/deletion policy. Active Prisma count is24 design models. Do not execute historical proposalDDL alongside generated migration; no validation/migration/SQL execution was performed here.

## P5-AM01 acceptance - Not executed

P5-DEL-01 independent write failure: no202/primary deletion commit. P5-DEL-02 durable intent then primary failure: scope blocked and reconciled, not falsely committed. P5-DEL-03 lost202: same-key original outcome, no new operation. P5-DEL-04 duplicate/delayed mirror: immutable scope and monotonic evidence. P5-DEL-05 older restore: independent coverage before any private read. P5-DEL-06 missing/stale authority: fail closed, no negative-cache bypass. P5-DEL-07 generation/research/PDF race: current context/lease/lifecycle and suppression checks reject late effects. P5-DEL-08 new signup: new empty incarnation, old data suppressed. P5-DEL-09 corrupted digest/version/key: recovery remains closed. P5-DEL-10 partial partitions: no accepted202 without verified intent plus primary commit. P5-DEL-11 concurrent same-key: one winning operation UUID; changed payload409. API/admission, privacy reconciler, workers and restore operator own their respective invariants; verification uses fault-injected store/DB barriers, authorization fixtures and isolated restore drills. All scenarios remain Not executed; static documentation checks are insufficient.
