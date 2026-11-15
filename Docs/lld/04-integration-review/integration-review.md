# Phase 2D final security, privacy and contract readiness

**Status:** Approved Phase 2D documentation — A07, revision FL-P2D-1.0-approved. Documentation approval is separate from implementation validation. No application code, deployment or Phase 3 work was started; canonical layout is unchanged.

## Outcome

The previously unspecified privacy/purge, verified-webhook inbox/tombstone, recreation, memory-context exclusion and snapshot/evidence contracts are now defined in existing canonical documents. Technical design closure is recorded for D02/D12/D13/D14/D22; five core product decisions are now explicitly approved; implementation proof remains deferred. Earlier discrepancy/reorganization evidence remains preserved as history. Current final disposition table in [register](discrepancy-register.md#final-closure-disposition--current-review-package) governs superseded findings.

## Canonical design ownership

| Responsibility | Specification / impact |
|---|---|
| Retention and privacy policy | [State machines](state-machines.md#privacy-and-retention-policy): data-category purpose/trigger/period/method/exception/component/verification; active retention/30-day active-system purge target approved; other retention settings tracked separately |
| Account/idea deletion and restore | [Lifecycle](state-machines.md#account-and-idea-deletion-lifecycle): ACTIVE -> DELETION_REQUESTED -> PURGING -> DELETED, retries/attention, checkpoint/manifest, storage races, restricted immutable DELETE and backup suppression |
| Clerk delivery and account recreation | [Security §16](../02-api-security/architecture-and-security.md#16-durable-clerk-webhook-and-identity-tombstone-design): official verified signature/event facts, unique durable inbox, deletion gate in admission tx, no webhook provisioning, new-subject signup only |
| Persistence and privileges | [Physical §12–13](../01-database/physical-design.md#12-final-privacy-and-identity-persistence-contract), [schema](../01-database/schema/schema.prisma), [guards](../01-database/constraints/guards.sql): 23 proposed models, two justified operational identity entities, retained DataOperation receipt, role/epoch/scope guard, context/artifact metadata |
| Memory/snapshot/evidence/export HTTP contracts | [API §13–16](../02-api-security/api-contracts.md#13-final-memory-contract-approved-product-policy-technical-validation-pending), [OpenAPI](../02-api-security/openapi.yaml): strict versions, context race boundary, frozen citations/hash, retry/download lifecycle, existing research setting reused |
| Acceptance and requirements | [FSEC scenarios](test-acceptance-matrix.md#final-securityprivacy-closure-scenarios), [traceability](traceability.md), [consistency](consistency-matrix.md): 16 final scenarios plus preserved CT/DB/C/I/R suites |

No architecture change: Express/TypeScript remains selected, PostgreSQL authoritative, independent API/workers, BullMQ/outbox durable work and Redis Pub/Sub ephemeral stream delivery. Immutable business history permits only reviewed scoped privacy DELETE; no ordinary edit or global trigger bypass. Failed/late workers cannot become a newer selected result. Backup restoration is fail-closed if latest suppression coverage cannot be established; no invented zero-data-loss guarantee.

## Sign-off recommendation and remaining actions

**Documentation sign-off recorded: A07 Approved.** The owner explicitly approved P2D-P01–P05, recorded in the [approval register](decision-log.md). The approved proposed maximum active-system purge target is 30 days; immediate access denial, recoverable cleanup, empty-account recreation, memory context exclusion and immutable/versioned snapshots remain mandatory. No approval date was supplied or invented. A07 identifies FL-P2D-1.0-approved in the [approved content manifest](approved-revision-1.0.json); A02 historical revision evidence remains an administrative record request. A08/O01 ancillary retention/provider/backup settings must be confirmed before deployment/beta; they do not reopen the five approved decisions.

Implementation acceptance remains **not ready**: Prisma validation, generated migrations/SQL roles and race tests, pinned Clerk/reauth/event fixtures, object/version/orphan cleanup, failure recovery and restore drills are unexecuted. Static results and limitations are in [validation report](validation-report.md). These execution gates do not make the documentation incomplete, and a documentation signature does not waive them.

The approved revision is frozen by the content manifest; future documentation changes require a new revision and review disposition. Phase 3 remains unstarted and requires a separate next-phase instruction after this task/sign-off. Do not bootstrap application packages or generate controllers from this report.
