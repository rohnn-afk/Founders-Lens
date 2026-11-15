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
