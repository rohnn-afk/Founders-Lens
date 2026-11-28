# Founder's Lens engineering documentation

**Status:** Approved — Documentation Only: Phase 2D A07, FL-P2D-1.0-approved; Phase 3 P3D-A09, FL-P3-0.3-approved (11 specification files); Phase 4 FE4D-A08, **FL-P4-0.5-approved** (20 technical specifications and3 historical controlled-amendment/proposal records). Implementation acceptance remains separate.

## Authority and review status

Explicit approved product decisions and active ADRs > PRD scope/goals > SRS requirements/acceptance > approved HLD boundaries > LLD detailed design > OpenAPI representation > test specifications. Raise a discrepancy instead of silently overriding a higher-level promise. Express + TypeScript supersedes Fastify. Confirmed stack: Next.js/TypeScript, Node.js/Express/TypeScript, Clerk, Zod, PostgreSQL/Prisma, BullMQ/Redis, REST/SSE; modular monolith with independent frontend/API/workers and Docker-compatible boundaries. AWS is preferred; hosting feasibility/cost not approved.

Statuses: Draft (incomplete proposal), In Review (reviewable design, not signed off), Approved (explicit owner/reviewer/version evidence), Superseded (historical; use linked replacement). The owner describes the prior PRD/SRS/HLD as approved in the current closure request; exact historical revision provenance remains D01. The Phase 2D closure has formal A07 approval; see the approval register and immutable revision manifest. Do not interpret In Review as runtime validation. The five core Phase 2D product decisions are explicitly approved in the decision log; ancillary retention/deployment proposals remain identified separately. Phase 3A–3D version 0.3 and seven declared amendments have explicit owner documentation sign-off under P3D-A09; numerical calibration and runtime/provider/security/model gates remain pending. No approval timestamp or Git commit is inferred.

## Canonical specifications

For the deployed read surface, start with the [Workspace API](../apps/api/WORKSPACE-API.md)
and the [staging release guide](../DEPLOYMENT.md). For local generation, follow
the [runtime runbook](../scripts/p9-local-runtime.md) from the API submission
through the dispatcher, worker and committed transcript. Use the
[implementation roadmap](lld/09-implementation-strategy/implementation-readiness-integration-review.md)
for verified acceptance and remaining gates.

| Responsibility | Canonical source |
|---|---|
| Product goals and scope | [PRD](requirements/PRD.md) |
| Requirements, invariants, acceptance IDs | [SRS](requirements/SRS.md) |
| Architecture and deployment boundaries | [HLD](architecture/HLD.md) |
| Active framework decision | [ADR-013](architecture/adr/013-express-typescript-api.md) |
| Preserved abbreviated decision | [Superseded ADR-002 revision](architecture/adr/002-express-revision.md) |
| Domain model and persistence | [Database index](lld/01-database/README.md), [logical](lld/01-database/logical-design.md), [physical](lld/01-database/physical-design.md) |
| Schema and PostgreSQL guards | [Prisma](lld/01-database/schema/schema.prisma), [SQL](lld/01-database/constraints/guards.sql) |
| Database acceptance plan | [Integration tests](lld/01-database/validation/integration-test-plan.md) |
| API architecture, Clerk and security | [Security design](lld/02-api-security/architecture-and-security.md), [review checklist](lld/02-api-security/review-checklist.md) |
| Public HTTP contract and inventory | [API contracts](lld/02-api-security/api-contracts.md), [OpenAPI](lld/02-api-security/openapi.yaml), [routes](lld/02-api-security/route-inventory.json) |
| API errors and verification | [API testing](lld/02-api-security/testing.md) |
| Streaming grammar and job reliability | [Streaming index](lld/03-streaming-reliability/README.md), [stream contract](lld/03-streaming-reliability/streaming-contract.md), [idempotency/concurrency](lld/03-streaming-reliability/idempotency-and-concurrency.md) |
| Streaming rationale and tests | [Decisions](lld/03-streaming-reliability/fundamentals-and-decisions.md), [tests](lld/03-streaming-reliability/testing.md) |
| Historical cross-phase coordination | [API handoff](lld/02-api-security/streaming-handoff.md), [contract delta](lld/03-streaming-reliability/contract-delta.md) |
| Phase 2D integration conclusions | [Integration review](lld/04-integration-review/integration-review.md) |
| Discrepancies and approvals | [Register](lld/04-integration-review/discrepancy-register.md), [decision log](lld/04-integration-review/decision-log.md) |
| Cross-layer mappings and state authority | [Consistency matrix](lld/04-integration-review/consistency-matrix.md), [state machines](lld/04-integration-review/state-machines.md) |
| Requirements and acceptance coverage | [Traceability](lld/04-integration-review/traceability.md), [acceptance matrix](lld/04-integration-review/test-acceptance-matrix.md) |
| Privacy policy and deletion lifecycle | [Policy and lifecycle](lld/04-integration-review/state-machines.md#privacy-and-retention-policy) (approved core policy; other retention settings tracked separately) |
| Clerk durable inbox and tombstones | [Security §16](lld/02-api-security/architecture-and-security.md#16-durable-clerk-webhook-and-identity-tombstone-design) |
| Exact A07 approved revision | [Content manifest FL-P2D-1.0-approved](lld/04-integration-review/approved-revision-1.0.json) |
| Reorganization history and validation | [Cleanup manifest](lld/04-integration-review/cleanup-manifest.md), [validation report](lld/04-integration-review/validation-report.md) |
| Historical Phase 2D-to-3 handoff | [Handoff](lld/04-integration-review/phase-3-handoff.md) (historical prerequisite record; current Phase 3 status below) |
| Phase 3A: AI orchestration architecture | [AI orchestration](lld/05-ai-orchestration/ai-orchestration-architecture.md) |
| Phase 3B: context and prompt architecture | [Context and prompts](lld/05-ai-orchestration/context-and-prompt-architecture.md) |
| Phase 3C: strategy, research and structured responses | [Strategy and response contracts](lld/05-ai-orchestration/strategy-research-structured-response.md) |
| Phase 3D: integration, findings, evaluation, traceability and approvals | [Integration/evaluation review](lld/05-ai-orchestration/ai-integration-evaluation-review.md), [P3D-A09 approval register](lld/05-ai-orchestration/ai-integration-evaluation-review.md#11-decision-and-approval-register) |
| Exact P3D-A09 approved revision (11 specification files) | [FL-P3-0.3-approved manifest](lld/05-ai-orchestration/approved-revision-0.3.json) |
| Accepted documentation exception | [AI-D14 controlled HLD clarification](lld/05-ai-orchestration/ai-integration-evaluation-review.md#68-streaming-and-higher-level-amendment); approved HLD remains unchanged |

## Phase 4 frontend design — Approved, Documentation Only

**FL-P4-0.5-approved — Approved, Documentation Only**, explicitly granted by the owner under FE4D-A08. Scope includes Phase4A–4D v0.5,FE4D-A01/A02/A03,P4-AM01–04 and P4-B01/B02 with their controlled technical amendments. Current OpenAPI0.5.0 has50 founder/53 total operations and the Prisma design has24 models. Title/hypothesis remain distinct;new creation3 is explicit,andfresh legacy creation has a disclosed rejection/upgrade policy. LearningEvidence/capture marker preserve durable sources andlegacy unknowns. All runtime,migration,provider,security,browser,mobile,accessibility,model andhosting/cost/deployment gates remain pending;no code ornext phase is authorized.

| Responsibility | Canonical source |
|---|---|
| Phase4A: fundamentals, journeys and proposed route tree | [Frontend architecture](lld/06-frontend/frontend-fundamentals-journeys-architecture.md) |
| Phase4B: wireframes, token owner and accessibility requirements | [Wireframes/design system](lld/06-frontend/wireframes-and-design-system.md) |
| Phase4C: all50 founder operations,state/auth ownership,session recovery/SSE | [State/API integration](lld/06-frontend/frontend-state-api-integration.md) |
| Phase4D: canonical review entry point,23 findings,47 FR trace rows,40 integrated scenarios,decisions,amendments,validation and readiness | [Frontend integration review](lld/06-frontend/frontend-integration-review.md) |
| Exact FE4D-A08 approved revision (23 baseline files) | [FL-P4-0.5-approved manifest](lld/06-frontend/approved-revision-0.5.json), [formal sign-off evidence](lld/06-frontend/frontend-integration-review.md#19-formal-phase-4-documentation-sign-off) |

Historical A07/P3 manifest bytes remain unchanged;their baseline files are no longer all current where explicitly amended. [Controlled amendment register](lld/06-frontend/controlled-amendments-0.3.json) and later records retain original old/new content fingerprints and historical dispositions. FE4D-A08 now freezes the current approved baseline separately; it does not rewrite earlier approvals or claim their historical member hashes are current. This index fingerprint is navigation-only supporting provenance.

## Maintenance rules

The [approved mapping closure](lld/06-frontend/frontend-integration-review.md#18-approved-final-mapping-closure-and-formal-review-readiness) andphysical§18/API§21 define the accepted mapping design; [formal sign-off](lld/06-frontend/frontend-integration-review.md#19-formal-phase-4-documentation-sign-off) defines current package approval. The [earlier proposal record](lld/06-frontend/mapping-proposals-0.4.json),0.3 controlled register and [mapping amendment record](lld/06-frontend/controlled-mapping-amendments-0.5.json) stay verbatim. Their previous package-pending statements are historical. The final manifest records administrative sign-off changes without claiming migration execution or authorization to start another phase.

Directories use lowercase kebab-case; Markdown uses lowercase kebab-case except README/PRD/SRS/HLD; structured files use conventional names. Keep one owner document per responsibility and link to it. Canonical designs identify purpose, scope/status, requirement/ADR dependencies, invariants, rationale, failure cases, acceptance and open questions; short test/index documents reference governing designs rather than duplicating them. Update incoming links and the index on every relocation. Tests/validation reports distinguish static checks from actual execution. No Kafka, Kubernetes, microservices or additional database is authorized.

## Phase 5 infrastructure and deployment - In Review

Canonical review entry point: [Phase5D](lld/07-infrastructure-and-deployment/infrastructure-integration-review.md#13-current-repository-reconciliation-and-operational-closure). Supporting specifications: [5A topology](lld/07-infrastructure-and-deployment/infrastructure-fundamentals-deployment-architecture.md), [5B storage/recovery](lld/07-infrastructure-and-deployment/storage-secrets-backup-recovery.md), [5C operations/cost](lld/07-infrastructure-and-deployment/hosting-cost-cicd-operations.md). Current reconciliation is v0.2; earlier draft intake remains historical. No Phase5 approval is granted. Independent deletion-suppression mirroring is inherited from Phase2D; recovery completeness and provider/retention choices remain blockers to public readiness. Approved Phase2D/3/4 baselines are preserved; this navigation update does not alter their technical scope.

Phase5 operational directions are now approved design only; [current approval/protocol register](lld/07-infrastructure-and-deployment/infrastructure-integration-review.md#14-operational-approvals-and-deletion-coverage-proposal) supersedes prior pending-direction labels. Candidate FL-P5-0.3-review remains not approved. P5-AM01 (independent pre-commit deletion-suppression intent) is Pending Owner Approval; frozen Phase2D/3/4 contracts remain unchanged.

P5-AM01 is explicitly approved for controlled documentation/design. Phase5D section15 and the Phase2D state-machines P5-AM01 section supersede earlier pending-proposal wording. Candidate FL-P5-0.4-review remains NOT APPROVED as a package. Existing approved manifests are preserved; the separate p5-am01-controlled-amendments-0.4.json register accounts for later authorized technical drift. Independent authority/provider/runtime proof remains pending.

## Phase 5 formal approved baseline

**FL-P5-0.4-approved - Approved, Documentation Only.** The owner's explicit formal sign-off supersedes earlier Phase5 package-pending wording. [Approval manifest](lld/07-infrastructure-and-deployment/approved-revision-0.4.json) freezes Phase5A-D and supporting controlled technical/audit files; [Phase5D approval register](lld/07-infrastructure-and-deployment/infrastructure-integration-review.md#16-formal-phase-5-documentation-approval) records evidence and deferred gates. Prior approved manifests and historical records are preserved verbatim. This index is navigation provenance, not an additional technical specification. All runtime/provider/restore/security/cost gates remain pending. No Phase6 or implementation authorization.

## Phase 6 testing, security and observability - In Review

Actual canonical directory: Docs/lld/08-testing-quality/. [Integration review](lld/08-testing-quality/testing-security-observability-integration-review.md#16-current-canonical-reconciliation-and-review-disposition) owns current findings/decisions/API and SRS matrices. [6A strategy](lld/08-testing-quality/testing-strategy-quality-architecture.md), [6B verification](lld/08-testing-quality/security-privacy-reliability-verification.md), [6C observability/evaluation](lld/08-testing-quality/observability-incident-response-ai-evaluation.md) retain all planned scenarios. Candidate FL-P6-0.2-review - Not Approved. No test implementation/execution or Phase7 authorization; approved Phase2D-5 baselines remain unchanged.

Phase6 operational directions are owner-approved design only; [current decision register](lld/08-testing-quality/testing-security-observability-integration-review.md#17-owner-operational-approvals-and-final-review-readiness) supersedes earlier pending-direction wording. Candidate FL-P6-0.3-review - Not Approved is ready for formal owner documentation sign-off review. Numerical durations/thresholds and tool/device/provider implementations remain provisional/unexecuted; public incident roles remain a prelaunch gate. No approved Phase6 manifest or Phase7 authorization.

## Phase 6 formal approved baseline

**FL-P6-0.3-approved - Approved, Documentation Only.** The owner's formal sign-off supersedes earlier Phase6 package-review labels. [Exact four-file approval manifest](lld/08-testing-quality/approved-revision-0.3.json) and [current sign-off register](lld/08-testing-quality/testing-security-observability-integration-review.md#18-formal-phase-6-documentation-sign-off) identify approved scope and deferred gates. This index is navigation provenance outside the technical file count. All runtime tests remain Not Executed; numerical targets and deployment/provider implementation remain deferred. Historical approvals unchanged; no Phase7 or implementation authorization.

## Phase 7 implementation planning - In Review

Canonical directory: Docs/lld/09-implementation-strategy/. [7D current review](lld/09-implementation-strategy/implementation-readiness-integration-review.md#14-current-canonical-repository-reconciliation), [7A strategy](lld/09-implementation-strategy/implementation-strategy-repository-architecture.md), [7B milestones](lld/09-implementation-strategy/implementation-milestones-vertical-slices.md), [7C task cards](lld/09-implementation-strategy/codex-task-specifications-quality-gates.md). Candidate FL-P7-0.2-review - Not Approved. Review preserves12 milestones,24 parent tasks,36 evidence IDs and18 findings; no approved Phase7 manifest. No M00 or implementation begins without separate explicit authorization.

## Phase 7 formal approved planning baseline

**FL-P7-0.2-approved - Approved, Documentation Only**, decision IMP7D-A01. [Exact four-file approval manifest](lld/09-implementation-strategy/approved-revision-0.2.json) and [current sign-off register](lld/09-implementation-strategy/implementation-readiness-integration-review.md#15-formal-phase-7-documentation-sign-off) supersede earlier package-review labels. All milestone/task authorization and runtime evidence remain separate: M00 has not begun and is not authorized. Earlier baselines unchanged; this index is supporting navigation provenance only. No coding,installation,migration,runtime tests,provisioning,paid calls ordeployment authorized.
