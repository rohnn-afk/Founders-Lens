# Decision and approval log

**Status:** Five product decisions explicitly approved by the project owner; Phase 2D documentation formally approved under A07 (FL-P2D-1.0-approved). Implementation validation remains separate.

## Approval evidence and scope

Evidence: the owner's latest instruction in this conversation explicitly approves the five decisions below. Approval date/signature/commit hash were not supplied and are not invented. This record captures the instruction; it does not claim a signed or deployed release. The owner’s subsequent explicit instruction to record formal sign-off approves A07 for the corrected documentation package. Previously approved stack, ADR-013, source hierarchy and baseline history remain unchanged.

| ID | Explicit owner decision | Disposition and operational boundary |
|---|---|---|
| P2D-P01 / A03 | Retain active data until deletion; proposed maximum active-system purge target 30 days; track backups separately | Approved policy direction and target, replacing the earlier 7-day live-purge proposal. Target is measured from deletion acceptance, not purge-worker start; not a measured SLA or a guarantee that every backup/provider copy expires in 30 days |
| P2D-P02 / A04 | Fresh authentication for account deletion, immediate access block and recoverable cleanup | Approved. Existing checkpoint/lease/scope design applies. Five-minute reverification is the documented engineering default, not a separately supplied numeric owner decision; pinned SDK/factor behavior must be verified |
| P2D-P03 / A04 | Account recreation as a new empty account, without restoring deleted data | Approved. Authenticate a fresh live Clerk subject, allocate a new local UUID; never relink by email or restore old workspace. Delayed webhooks cannot provision/reactivate an identity |
| P2D-P04 / A05 | Removed memory excluded from future AI context; historical conversation/snapshot and in-flight handling documented | Approved. contextEpoch checks prevent obsolete new dispatch/final commit; historical text and approved snapshots stay historical until privacy purge; already authorized external calls may be in flight |
| P2D-P05 / A06 | Approved Idea Snapshots immutable; changes create new versions; reasonable documented PDF export limits | Approved. Existing typed content/hash/citation design retained. Bounded PDF defaults are delegated engineering controls in API §17, not separately owner-attested numbers; tune from validation without weakening immutability/privacy |

## Remaining register and gates

| ID | Item | Status / next action |
|---|---|---|
| A01 | Confirmed stack and active Express ADR-013 | Approved architecture; no framework reapproval required |
| A02 | Prior owner-attested PRD/SRS/HLD baseline | Accepted for this review; exact historical revision/signature evidence unrecorded. Record actual provenance if available, never reconstruct it |
| A07 | Formal Phase 2D documentation package disposition | **Approved** by explicit project-owner instruction; revision **FL-P2D-1.0-approved**, exact file hashes in [approved content manifest](approved-revision-1.0.json). No approval date supplied; no production/runtime acceptance |
| A08 | Other retention figures (logs/inbox/security/ledger/tombstone, backup horizon, PDF cache/account-export artifact TTL), account-export ZIP/JSON format and 20 MiB capture proposal | Remain proposed/deployment dependent where not covered by the five decisions. Confirm actual settings/disclosures before beta; do not label them explicitly owner-approved. They do not reopen the five approved principles |
| V01 | Prisma, migrations/SQL privileges/races, Clerk SDK/reauth/revocation, queue/storage/restore/export proof | Implementation-stage validation; not executed. Documentation approval never waives these gates |
| O01 | AWS hosting, backup capabilities, external-provider retention, URL revocation, quotas/SLO/RPO/RTO | Open deployment/provider choices. Select and verify before activation/beta; incompatible capabilities require explicit policy revision |

No approval date was supplied. A07 evidence is the owner’s explicit instruction in this conversation to “Record formal sign-off” and identify the exact approved revision. Do not use the execution date as approval evidence. Future changes must preserve this approval manifest and record a new revision/disposition; they are not automatically covered by A07.

## Technical design preserved

PostgreSQL remains authoritative. WebhookInbox and independent IdentityTombstone prevent duplicate delivery/resurrection; only authenticated provider-live signup provisions an empty account. Restricted SECURITY DEFINER purge entry point and invoker role/epoch/scope guard permit authorized privacy DELETE without ordinary immutable-history edits. DataOperation retains minimal recoverable purge/export receipts. contextEpoch fences stale memory context, leaseEpoch fences stale workers, draftRevision protects previews, and artifact availability is distinct from terminal job execution. No application feature, new service/database or Phase 3 work is authorized by this record.


## Approved revision identity

**FL-P2D-1.0-approved** is a content-addressed working-tree snapshot, not a fabricated Git commit. The repository has uncommitted documentation changes; base HEAD alone cannot identify them. [approved-revision-1.0.json](approved-revision-1.0.json) records the actual base commit, all approved Docs files plus root README, their raw-byte SHA-256 hashes/lengths and an aggregate digest. The manifest excludes only itself to avoid circular hashing; this decision log and validation evidence are included. Verify aggregate SHA-256 over UTF-8 JSON.stringify(files), with entries in lexical path order and each entry’s keys ordered path, sha256, bytes. Then compare current files to the recorded hashes. Later edits intentionally differ until a new reviewed revision is recorded; never overwrite the original manifest. Historical A02 baseline hash evidence is not retroactively invented.

## Controlled amendment P5-AM01 - Approved, Documentation Only

The owner explicitly approves independent durable deletion intent before primary commit, authoritative unresolved-intent suppression, immediate primary-commit access blocking, idempotent reconciliation and closed restore until verified. Evidence: current P5-AM01 controlled privacy amendment instruction; no date/signature/commit inferred. The current state-machines P5-AM01 section owns the protocol. This is a controlled later amendment, not a rewrite of A07 or Phase4 approval. New availability dependency and uncertain-intent blocking are accepted design consequences. Runtime/storage/restore validation and final Phase5 sign-off remain pending.
