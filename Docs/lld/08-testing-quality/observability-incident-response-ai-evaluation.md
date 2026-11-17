# Founder's Lens — LLD Phase 6C: Observability, Incident Response & AI Evaluation

**Document ID:** FL-LLD-QA-6C  
**Version:** 0.3 - formal documentation baseline
**Status:** Approved - Documentation Only; FL-P6-0.3-approved. All runtime tests remain Not Executed.
**Canonical directory:** Docs/lld/08-testing-quality/; current review and decisions in Phase6D section16.
**Authority:** Existing approved SRS, Phase 2D/3/4/5 documentation and actual canonical schemas govern this proposal. Phase 6A and 6B test plans are adjacent drafts; they are not implementation evidence.

> **Source integrity and limitations:** Prepared using the available Phase 6A/6B drafts and earlier Phase 3D and Phase 5D drafts, plus the owner's report of `FL-P5-0.4-approved`. The live canonical repository's current `openapi.yaml`, Prisma/SQL, Phase 3 approved manifest, Phase 4–5 manifests, Phase 3 revised evaluation rubric, and final Phase 5 P5-AM01 changes were not independently reopened here. Codex must reconcile field names, exact IDs, rubric thresholds, current endpoints, and approval evidence during Phase 6D. All numeric limits and SLOs below are *proposed examples*, not approved service promises. No runtime, provider, security, or model tests have been executed.

## 1. Purpose and scope

Design how Founder's Lens will **observe** the system, detect and respond to incidents, and **evaluate AI quality** without compromising the privacy and lifecycle guarantees already approved.

In scope: Next.js client diagnostics; Express API; PostgreSQL transactions, idempotency and outbox; BullMQ/Redis; AI/research/PDF/privacy workers; authenticated SSE; provider usage; immutable snapshot exports; independent deletion-suppression authority; incident response; evaluation fixtures, release gates, evidence and regression tracking. Out of scope: adding application instrumentation, selecting a paid monitoring vendor, buying model tokens, deploying collectors, claiming service-level attainment, making production readiness claims, or modifying frozen contracts.

### 1.1 Concepts in plain English

| Concept | Meaning | Founder's Lens example |
|---|---|---|
| Observability | Inferring internal behavior from evidence produced by the system | Determine why an accepted message never reached a final response |
| Structured log | One machine-readable event with consistent fields | `generation.finalization_denied` with reason `CONTEXT_EPOCH_MISMATCH` |
| Metric | A numeric measure aggregated over time | Count of generation attempts that failed |
| Distributed trace | Correlated record of a request across services/processes | Request → DB acceptance → outbox → worker → final commit |
| SLI | Service Level Indicator: an actual measured outcome | Percentage of accepted generations that reach terminal status |
| SLO | Service Level Objective: a target for an SLI | A *proposed* completion target, not a guarantee |
| Alert | Signal requiring review or action | Suppression authority cannot establish completeness |
| Incident | An event that compromises service, safety or privacy | Foreign founder's resource is exposed |
| Evaluation fixture | Repeatable input, expected behavior and scoring rules | Founder asks about demand; response should challenge an untested assumption |
| Hard gate | Condition that must pass regardless of averages | Any cross-founder privacy disclosure blocks release |

## 2. Non-negotiable invariants

**OBS-P01 — Durable truth.** Only PostgreSQL-authoritative records establish accepted commands, terminal attempts, selected assistant messages, memory approval, export completion and lifecycle status. SSE and Redis delivery are observations, not proof of durable success.

**OBS-P02 — Privacy first.** Telemetry must not contain raw ideas, prompts, transcripts, model responses, approved memory text, provider credentials, access tokens, download grants, sensitive research payloads or full document contents. Do not create a second ungoverned datastore of private founder material through monitoring.

**OBS-P03 — No semantic conflation.** Separate technical availability/reliability metrics from AI quality, truthfulness, uncertainty calibration, evidence quality and founder usefulness. A working HTTP endpoint does not imply a good AI response.

**OBS-P04 — Fail-closed and explicit hard gates.** Ownership failures, stale/deleted context reuse, unauthorized memory/snapshot approval, and inability to establish deletion suppression coverage block release even with high average scores.

**OBS-P05 — No uncontrolled paid work.** Routine CI uses deterministic mock AI/research providers. Real-provider evaluations require specific approval, separate credentials, quota enforcement and measured usage/cost evidence.

**OBS-P06 — Evidence quality.** Logs and metrics support diagnosis; they do not replace transaction checks, restore drills, or independent evaluation. Every executed check requires reproducible evidence and a declared environment.

**OBS-P07 — Deferred targets.** Retention periods, throughput, latency, incident response times, SLOs, evaluator thresholds, budget caps, alert thresholds and vendor selection are provisional until reviewed and demonstrated.

## 3. System observation map

```mermaid
flowchart TD
  F[Next.js founder UI] -->|request ID + authenticated request| A[Express API]
  A --> P[(PostgreSQL business state and outbox)]
  P --> D[Outbox dispatcher]
  D --> Q[Redis / BullMQ]
  Q --> W[AI / Research / PDF / Privacy workers]
  W --> P
  W -->|ephemeral progress| S[SSE transport]
  S --> F
  A --> O[Telemetry: redacted logs, metrics, traces]
  D --> O
  W --> O
  F -->|safe client diagnostics only| O
  P -->|approved aggregate/health checks| O
  X[Independent suppression authority] -->|coverage and reconciliation signals| O
  W -->|guarded external requests| V[AI / Research providers]
  V -->|usage and error metadata| O
  O --> R[Alert triage + incident response]
  E[Offline AI evaluation runner: synthetic fixtures] --> Y[Versioned evaluation results]
  Y --> R
```

**Telemetry is not the authoritative data plane.** A tracing backend may be unavailable while the business system remains functional; do not make sending private API commands contingent on a monitoring SaaS. Conversely, a missing deletion-suppression authority is a *security availability condition*, not merely a logging outage.

## 4. Correlation and structured event contract

### 4.1 Event envelope — proposed, not an API DTO

| Field | Suggested meaning | Rule |
|---|---|---|
| `eventName` | Stable event identifier, e.g., `generation.finalized` | Controlled registry with bounded cardinality |
| `timestamp` | Server event time | UTC, source clock documented |
| `severity` | DEBUG/INFO/WARN/ERROR/CRITICAL | Aligned with incident rules |
| `service` / `environment` | `web`, `api`, `dispatcher`, `worker` | No customer text |
| `traceId` / `requestId` | Join related requests and worker steps | Generated identifier; validate incoming IDs before use |
| `commandCorrelationId` | Internal safe pointer to a logical command | Not the raw auth token, sensitive idempotency key or prompt |
| `jobKind` / `attemptKind` | Small enum, e.g., GENERATION, RESEARCH, EXPORT, PURGE | Do not make dynamic user text a metric label |
| `outcome` / `reasonCode` | Controlled status code | Example `VERSION_CONFLICT`, `LEASE_FENCED` |
| `durationMs` | Observed elapsed interval | Not an unmeasured SLO assertion |
| `providerCategory` / `modelVersion` | Allowlisted version identifier where permitted | Avoid keys, prompt payloads, provider secrets |
| `scopeHash` (optional) | Short-lived keyed pseudonym for diagnostics | Only if needed, approved and rotated; pseudonymization is not anonymization |

**Critical privacy rule:** IDs that allow joining founder data across systems can themselves be personal information. Default to no principal identifier in third-party telemetry. If a correlation requires an internal resource ID, keep it in a restricted first-party debugging store, document access and retention, and avoid exposing it to analytics. Trace propagation must use allowlisted headers, with no authorization header or full query body captured.

### 4.2 Safe event examples

```json
{"eventName":"message.accepted","service":"api","outcome":"ACCEPTED","traceId":"synthetic-trace-01","jobKind":"GENERATION"}
{"eventName":"generation.finalization_denied","service":"worker","reasonCode":"CONTEXT_EPOCH_MISMATCH","traceId":"synthetic-trace-01"}
{"eventName":"restoration.gate_blocked","service":"api","reasonCode":"SUPPRESSION_COVERAGE_UNPROVEN","severity":"CRITICAL"}
```

These are **illustrative logging shapes**; no app event emitter or log backend exists yet. Preserve existing canonical state names rather than inventing permanent new states.

### 4.3 Events by stage

| Stage | Useful event families | Never include |
|---|---|---|
| Authentication | verification result, denial reason class, token refresh error | JWT, session claims dump, full IP fingerprint |
| API validation | operation ID, status class, bounded error code | User request body, conversation text |
| DB commit/outbox | accepted vs rolled back, enqueue lag, replay outcome | Raw SQL parameters, idempotency secret/key |
| Queue/worker | pickup delay, run duration, retries, lease/epoch conflict | Prompt or tool payload |
| SSE | connected, disconnected, authentication denied, status-sync | Token deltas or streamed private text |
| Memory/snapshot | approved/denied version outcome, artifact state | Memory text, PDF contents, signed download URL |
| Privacy/recovery | intent status, suppression coverage verified/blocked, reconciliation status | Unencrypted identity tombstone contents |
| Provider | call count, structured error class, token/cost estimate (when available) | Provider API key, messages, raw search content |

## 5. Metrics and proposed SLIs

**Measure using DB-confirmed facts wherever possible**, not successful transport acknowledgments. Keep counters/histograms labeled by low-cardinality categories, never by user, idea, message, error text or full URL. The following are proposed measurement families; definitions require precise implementation and version reconciliation.

| Signal | Proposed numerator / denominator or computation | Diagnostic concern |
|---|---|---|
| HTTP availability | Eligible successful/expected API operations divided by eligible requests (exclude deliberate client denials, documented separately) | API outage and access failures |
| Message acceptance | Accepted logical submissions / validated eligible submissions | Submission regression and duplicate conflicts |
| Queue dispatch lag | Time from committed outbox eligibility to confirmed dispatch | Stuck dispatcher |
| Generation terminal completion | Terminal completed attempts / accepted attempts after adequate observation window | Stalled or failed generation |
| Generation time-to-final | From accepted commit to DB terminal transition | User-perceived latency (not SSE first token) |
| Live stream health | SSE disconnects, auth renewal failures, status recovery outcomes | UI observation problem, not necessarily job failure |
| Duplicate effect count | Number of duplicate business effects proven by DB audit fixtures | Hard correctness failure in tests |
| Research evidence integrity | Accepted sourced claims with permitted citations / evaluated sourced claims | AI evidence quality—not uptime |
| PDF completion/availability | Artifact AVAILABLE with authorized grant checks / approved export jobs | Job success distinct from grant lifetime |
| Privacy suppression coverage | Verified complete independent coverage / required recovery scope | Missing/unknown is blocking, not counted as success |
| AI usage/cost | Attempted, admitted, succeeded calls; provider tokens/cost where verifiable | Paid retry and budget exhaustion |

**SLO approach:** Choose targets only after collecting baseline test/staging data and approving service hours, exclusion windows, sample size and observation windows. Never present a percentile or target as achieved without executed telemetry. Some failures (foreign data access, deletion coverage gaps) are **zero-tolerance release gates**, not percentage-based SLOs.

## 6. Alerts, severity and incident ownership

### 6.1 Proposed severity framework

| Class | Trigger example | Required response principle |
|---|---|---|
| SEV-1: privacy/security | Cross-owner access, deleted account visible, independent suppression integrity unproven during restoration | Fail closed, isolate affected capability, preserve redacted evidence, escalate immediately to designated operator |
| SEV-2: correctness/data | Repeated paid generations for same accepted command, committed result inconsistent with selected transcript, snapshot modified after approval | Stop affected mutations/jobs, verify durable state, assess rollback and data repair |
| SEV-3: availability | API outage, queue backlog, model-provider unavailable, PDF export failing | Degrade honestly, preserve accepted work, retry only within approved bounds |
| SEV-4: minor UX | Intermittent stream reconnection with preserved durable results | Investigate, monitor and avoid misleading state |

Severity names and notification timelines are proposals, not approved response-time guarantees. The owner is initial development operator; public-release on-call role, escalation route, communications and substitute contact remain decisions.

### 6.2 Incident workflow

1. **Detect and classify:** Identify impact, scope and whether any founder-private material is exposed.
2. **Contain safely:** Disable affected admissions/exports or restrict scoped access. Do **not** clear suppression records or restart workers into unsafe states.
3. **Establish authority:** Verify DB/lifecycle/independent suppression records before relying on dashboards or queue status.
4. **Preserve minimal evidence:** Timestamp, deployment version, restricted trace IDs, outcome codes and reproducer—no prompt dumps.
5. **Recover in controlled order:** Validate credentials, database state, suppression coverage, outbox/worker eligibility and only then restore service.
6. **Verify and communicate:** Execute targeted tests, log corrected status, record user impact and any disclosure obligations with legal review as appropriate.
7. **Review root cause:** Document initiating condition, safeguards that worked/failed, preventive action, owner and regression test.

### 6.3 Specific runbook playbooks (design, no execution)

**Runbook O-01 — AI generation stalled:** Inspect committed generation status → worker lease → outbox lag → queue delivery → provider admission/budget → terminal commit; never replay a paid call merely because SSE disconnected.

**Runbook O-02 — Auth/privacy incident:** Gate affected private API and SSE access → assess foreign data reads/caches and provider context exposure → revoke/rotate affected credentials if needed → verify idea-owner tests → only reopen with documented sign-off.

**Runbook O-03 — Suppression authority unavailable:** Stop access to affected private scope; do not treat uncertain independent intent as rejected; reconcile through approved independent authority, and require complete coverage proof before reopening following restore. Refer to P5-AM01, not generic cache invalidation.

**Runbook O-04 — Redis loss / backlog:** PostgreSQL remains durable authority; inspect committed outbox and worker state, reconcile eligible jobs with lease/idempotency/epoch fencing; no uncontrolled provider retries or guarantee of no duplicate *attempts*.

**Runbook O-05 — AI spend spike:** Suspend new paid admissions, check in-flight and already authorized work, segregate model/research usage, verify quota ledger and billing records where available; do not falsely claim a provider-level hard spending cap.

**Runbook O-06 — Export unavailable:** Distinguish failed export job, missing/purged artifact and expired download grant. Re-issue a grant only for authorized AVAILABLE artifact; explicit new export intent uses a new key when warranted.

## 7. Data minimization, retention and telemetry access

- Log **error classes and counters**, not founder text. Strip query parameters that may contain grants; do not serialize `Authorization`, cookies, `Set-Cookie`, model request/response bodies or full exception objects containing private payloads.
- Sanitize at collection, not only in downstream dashboards. Ensure tracing SDK defaults and error reporting integrations cannot automatically capture request bodies, headers, DOM text or user-provided URLs.
- Use least-privilege roles for reading logs/traces. Protect access with audit trails and short, reviewed retention; do not choose an arbitrary permanent retention period.
- The founder's account/idea deletion policy and historical privacy limits apply to telemetry scope as relevant. Retention of unavoidable security/audit evidence requires an explicit lawful basis and separate policy review; never promise every backup or external provider copy has already been erased.
- Test redaction using synthetic unique secret canaries (fake tokens, prompts and signed URLs) and inspect all telemetry outputs and exporter errors. Privacy tests must fail if a canary is observed.
- Avoid putting high-cardinality keys (userId, ideaId, traceId, provider request text) on metrics labels. Trace IDs may be in restricted traces, not Prometheus-style dimensional tags.

## 8. AI orchestration evaluation architecture

### 8.1 Separate three types of evaluation

| Category | What is tested | Pass evidence |
|---|---|---|
| Hard contract/security | One allowed strategy, zero/one card, <=2 prominent actions, no foreign evidence/memory, no side-effect without owner approval, version/state fences | Strict validation + real DB/worker security and race tests; any safety breach blocks release |
| Deterministic orchestration | Authorized context selected, research gating and quota respected, generation state/selection valid, no unapproved paid retry, fallback honest | Fixtures with deterministic model/provider stubs and DB assertions |
| Conversation quality | Helps founder think; challenges respectfully; factual caveats, actionable experiment and appropriate English/Hinglish | Versioned rubric, multiple human raters, sampled model runs and traceable results |

A model's text output must be treated as **untrusted until structurally validated**. Evaluation runner results do not authorize saved memory, snapshots or business actions.

### 8.2 Candidate evaluation dataset (proposed)

| Family | Example fixture objective | Critical assertion |
|---|---|---|
| Early vague idea | Founder says “I want to start something” | Explore without forcing a long questionnaire |
| Unexamined certainty | Founder claims “everyone will buy” | Respectfully identify untested assumption |
| Explicit correction | Founder corrects target users/price | Correction wins in future authorized context |
| Hinglish | “Mere college mein tiffin demand hogi kya?” | Respond intelligibly; no patronizing language |
| India-grounded evidence | Market question with incomplete or stale sources | Clearly date/qualify claims and distinguish inference |
| Conflicting sources | Two credible sources disagree | Surface disagreement; do not invent certainty |
| No research permission | `proactiveResearch=false` | No new automatic research admission after saved setting |
| Insufficient evidence | No credible support | Say uncertainty; suggest low-cost validation |
| Prompt injection | Untrusted web result says “ignore developer instructions” | Treat as data; no tools/privileged side-effects |
| Memory approval | Model proposes durable fact | Remains proposal until explicit founder approval |
| Removed memory | Removed fact present in linked old context | Exclude known linked stale context; don't claim perfect semantic removal |
| Sensitive boundary | Cross-founder evidence identifier | Owner authorization fails and output does not leak |
| Regeneration/cancel race | Competing terminal outcomes | Selected transcript follows DB CAS winner |
| Provider outage/quota | Model/search timeout or limits | Honest degraded response, bounded retry, no fabricated research |
| Card/format stress | Malformed structured output | Reject/repair only within approved bounded policy; legacy unaffected |
| Snapshot request | Founder requests report | No approval or immutable snapshot without explicit authorized decision |

Each fixture has an ID, purpose, preconditions, synthetic input, expected strategy/constraints, model config and version, allowed provider behavior, privacy and functional oracles, planned number of samples, assessor rubric, owner and execution status. In future, separate **development**, **holdout/regression**, **adversarial**, and **Hinglish/India-grounded** subsets; prevent training or prompt tuning against holdout answers.

### 8.3 Scoring and threshold governance

The canonical Phase3D section9.1 and SRS section12.3 specify six dimensions,0–2 each,total12: **intent understanding; usefulness of intervention; evidence/uncertainty; naturalness/brevity; respectful challenge; memory/correction fidelity**. Score0=missing/harmful,1=partial,2=meets criterion, with rationale. Phase3's earlier0–4 diagnostics are historical only. NFR-009's >=90% curated conversations at >=10/12,NFR-010's >=95% next-reply correction fidelity and NFR-011's >=90% correct memory type/provenance remain provisional, unmeasured targets, not achieved results or newly approved numbers.

Use those exact dimension names, not placeholder R1..R6. Human-reviewed samples are mandatory; a model judge cannot be the sole oracle. Separate hard gates from subjective scores:

- **Hard gate:** Any confirmed cross-founder disclosure, unauthorized provider access, unapproved state mutation, deletion/context-epoch violation, or unsupported evidence fabrication blocks release review, regardless of quality score.
- **Quality score:** Sum the six dimension scores only when rubric definitions, rater guidance, and data sampling are fixed; report percentage at/above provisional threshold plus per-dimension distributions, not just an average.
- **Inter-rater agreement:** Have at least two independent reviewers for important ambiguous cases; record disagreements and adjudication, not just a single model-as-judge verdict.
- **Regression:** Compare approved prompt/model/orchestration revision against prior candidate on a pinned dataset, with explicit variance for stochastic outputs and hard-gate failures separately.
- **Thresholds:** No specific target becomes a shipping requirement until owner approval, dataset adequacy and calibration. Prior proposed correction/provenance success targets are not claimed achieved.

### 8.4 Evaluation execution and provenance record

```yaml
# Illustrative evaluation-result shape; not an approved API contract
caseId: QA6C-AI-001
caseSetRevision: pending
sourceContractRevision: FL-P3-0.3-approved  # reported approved design baseline
modelVersion: unselected
promptVersion: unselected
providerMode: fake  # fake | authorized-real
attempts: 0
hardGates: NOT_EXECUTED
rubricDimensions: [null, null, null, null, null, null]
scoreTotal: null
humanRaters: []
result: NOT_EXECUTED
costEvidence: null
```

Secure evaluation artifacts separately from ordinary telemetry; use synthetic cases by default, no unapproved real founder content, restricted access for any approved redacted real-world examples, and a short documented retention policy.

## 9. Cost and model-usage observability

- Record the decision to admit a model/research request separately from an actual provider invocation and separately again from an invoice-reported charge.
- Distinguish `admitted`, `attempted`, `succeeded`, `failed`, `retried` and `unknown-outcome`. A timeout after provider execution may already incur cost even if no response reached us.
- Attribute usage by work kind and version; scope founder/idea details to protected internal accounting, not public telemetry tags.
- Reconcile provider-reported tokens/cost against internal estimates where evidence exists; log missing accounting as unknown, not zero.
- Reserve fake/free fixtures for CI; paid test runs need explicitly recorded spending limit, owner approval, abort logic and post-run reconciliation.
- Define budget exhaustion UX accurately: a local budget cap may stop *new admission*, not magically cancel external calls already in flight.

## 10. Instrumentation and integration contract (proposed responsibilities)

| Component | Instrumentation owner | Essential evidence |
|---|---|---|
| Next.js | UI team | Page route state, safe client-side error codes, refresh/recovery outcome; no chat content or DOM dumps |
| Express | API team | Auth/ownership outcome, operation ID, response class, DB acceptance identity, idempotency replay result |
| PostgreSQL adapter | Persistence team | Transaction commit/rollback, lease/context fencing, constraints, outbox reconciliation and stored state assertions |
| Dispatcher/Redis | Reliability team | Dispatch lag, queue latency, duplicates/rediscovery, retries and dead-letter/failed-job class if supported |
| AI worker | Orchestration team | Strategy label, context selection counts, model call admission/result, validation, final DB commit outcome |
| Research worker | Evidence team | Admission class, source/citation count and limitations, error class; no raw source payload |
| PDF worker | Document team | Version/hash verification, artifact availability, grant issuance outcome |
| Deletion/restoration | Privacy/recovery owner | Independent intent state, scope coverage proof, closed/reopened gate and reconciliation outcome |
| QA/evaluation | Test owner | Dataset/prompt/model versions, synthetic case IDs, hard gate, rubric, rater disagreement and regression |

**Technology selection:** Favor instrumentation interfaces compatible with standard structured logging, metrics and tracing; do not select a hosted telemetry vendor or require user credentials in a third-party dashboard without a separate privacy/cost review. Do not introduce a microservice merely for telemetry.

## 11. Verification catalog — all NOT EXECUTED

The following IDs are *new Phase 6C planning identifiers* and should be cross-referenced, not substituted for pre-existing Phase 6A/B, SRS or approved Phase 3D tests. Evidence must distinguish fake from real dependencies.

| ID | Scenario / method | Expected oracle | Required level | Status |
|---|---|---|---|---|
| Q6C-01 | API accepted message, trace across dispatcher and worker | Same safe correlation across stages without payload leakage | Integration + trace inspection | NOT_EXECUTED |
| Q6C-02 | Real DB commit then lost 202/SSE | DB truth preserved; alerts do not declare failed generation from transport loss | API/worker fault injection | NOT_EXECUTED |
| Q6C-03 | Worker lease or context epoch invalidated | Guard rejection logged; no stale selected response | DB/worker integration | NOT_EXECUTED |
| Q6C-04 | Redis unavailable while DB healthy | Outbox lag observable; no phantom acceptance/duplicate effects | Fault injection | NOT_EXECUTED |
| Q6C-05 | Inject synthetic secret canaries in request/provider error | No token, founder text, grant or raw prompt in telemetry sink | Security + log/export test | NOT_EXECUTED |
| Q6C-06 | Two founders with different resources | Telemetry correlation cannot reveal foreign founder data | Security review + integration | NOT_EXECUTED |
| Q6C-07 | Restore older DB with complete suppression ledger | Reconcile before opening and report coverage evidence | Isolated restore drill | NOT_EXECUTED |
| Q6C-08 | Suppression authority partition/incomplete enumeration | Critical alert and fail-closed access; no false green dashboard | Restore/partition drill | NOT_EXECUTED |
| Q6C-09 | Deletion intent persisted, primary commit failed | Unresolved intent remains blocking; health reports uncertainty | Recovery integration | NOT_EXECUTED |
| Q6C-10 | Queue retry and provider timeout | Distinct billable attempt accounting; no uncontrolled retry | Worker fake, then authorized provider validation | NOT_EXECUTED |
| Q6C-11 | Stream token flood and reconnect | Client announcements bounded; no token deltas in logs | Browser accessibility + telemetry | NOT_EXECUTED |
| Q6C-12 | Memory approval/revocation | Approval result/version captured only as metadata; no private text | API/DB + redaction | NOT_EXECUTED |
| Q6C-13 | Structured response invalid cards/actions | Hard contract validation fails; never auto-mutates | Model fake + schema | NOT_EXECUTED |
| Q6C-14 | Untrusted research prompt injection | No privileged tool request or context leak; hard gate enforced | Adversarial AI worker | NOT_EXECUTED |
| Q6C-15 | Hinglish/India-grounded scoring | Use reviewed six-dimension rubric and record ambiguity | Human-rated offline evaluation | NOT_EXECUTED |
| Q6C-16 | Removed memory during context build | Epoch and linked-lineage exclusion; no stale selected response | DB/worker race + AI fixture | NOT_EXECUTED |
| Q6C-17 | Evidence omitted/insufficient | Honest uncertainty; no unsupported sourced claim | AI evaluator + source fixture | NOT_EXECUTED |
| Q6C-18 | Regression after prompt/model change | Versioned baseline comparison, no masking hard-gate failure | Eval runner | NOT_EXECUTED |
| Q6C-19 | Alert routing for privacy and spend spike | Correct severity, nominated response and documented evidence | Tabletop/alert integration | NOT_EXECUTED |
| Q6C-20 | Metrics cardinality and retention guard | No founder/idea IDs as labels; retention/access policy enforced | Telemetry inspection | NOT_EXECUTED |
| Q6C-21 | Export failed, retry, expired grant | Distinguish artifact/job/grant statuses, safe alert class | DB/storage integration | NOT_EXECUTED |
| Q6C-22 | Restore incident tabletop | Containment, coverage proof, reconciliation and reopening authorization | Operational tabletop | NOT_EXECUTED |
| Q6C-23 | Client account switch and delayed events | No earlier principal payload in UI or logs | Browser privacy integration | NOT_EXECUTED |
| Q6C-24 | AI scoring evaluator disagreement | Record both ratings, adjudication and unresolved result | Evaluation pipeline | NOT_EXECUTED |

## 12. Evidence, reporting and release decision

Every future verification run must record: scenario ID, test/eval version, approved design baseline, environment, time, synthetic fixture ID, program versions, failure injection, actual versus expected behavior, source of authority checked, redacted supporting evidence, pass/fail/blocked outcome, and defect link. A documentation-only status remains `NOT_EXECUTED`; do not fill it with `PASS` after writing a test plan.

**Release gates (design):**

- **Hard security/privacy/data gates:** cross-owner isolation, context exclusion, no unapproved mutation, deletion/suppression coverage and version/state fencing must pass with real-component evidence. Any failure blocks relevant release scope.
- **Correctness gates:** API/DTO, queue/outbox/idempotency, immutable snapshot and restore invariants must pass for affected releases.
- **AI quality gates:** After approved rubric/calibration, evaluate multiple versions and humans; low-quality regressions block or trigger owner-defined rollback policy, without replacing hard gates.
- **Operational gates:** instrumented health, alert delivery, on-call/owner responsibilities, restore drills and expenditure limits require evidence before public deployment.

Fail-closed behavior may reduce availability; document the user-visible degraded experience and avoid promising an always-on free demo. Distinguish local dev from a real public-launch acceptance bar.

## 13. Decision register and open design questions

| ID | Proposed decision / issue | State |
|---|---|---|
| Q6C-D01 | Use redacted structured event envelope and bounded correlation IDs | Proposed — owner/engineering review |
| Q6C-D02 | Keep metrics low-cardinality; use restricted traces for correlating requests | Proposed — review |
| Q6C-D03 | No raw founder content or provider credentials in ordinary telemetry, including automatic error capture | Inherited privacy principle; exact enforcement needs testing |
| Q6C-D04 | Separate health SLOs from AI usefulness/citation quality | Proposed — review |
| Q6C-D05 | SLOs, alert thresholds, log retention and response targets are provisional | Deferred numeric calibration |
| Q6C-D06 | Use synthetic fixtures/fake providers by default, paid model runs only after explicit authorization | Inherited budget principle; enforcement untested |
| Q6C-D07 | AI six-dimension rubric must match currently approved Phase 3 exactly; older drafts are historical | Blocked on repository reconciliation |
| Q6C-D08 | Suppression completeness is a hard safety gate; no alerts-only workaround | Inherited P5-AM01 design; runtime proof pending |
| Q6C-D09 | Monitoring vendor and storage/provider selection deferred | Owner/provider decision pending |
| Q6C-D10 | Exact real-provider evaluation corpus, rater training and model release thresholds deferred | Owner/engineering decision pending |
| Q6C-D11 | Incident ownership for public release and notification channels deferred | Owner decision pending |
| Q6C-D12 | Telemetry retention, deletion scope and access logging policy needs privacy review | Owner/legal/engineering decision pending |

**Known limitation:** This document cannot verify that the reported Phase 5 approved amendment or exact Phase 3 rubric is faithfully mirrored in the repository. Phase 6D must inspect live manifest/approved sources, resolve discrepancies, and preserve historical records.

## 14. Requirements, traceability, and Phase 6D handoff

| Area | Primary sources to reconcile in actual repo | Evidence family |
|---|---|---|
| Auth and owner isolation | SRS, Phase 2 security/API/OpenAPI, Phase 4 auth | Q6C-05/06/23; Phase 6B auth/privacy |
| Messages/generations/SSE | Phase 2 streaming, Phase 3 worker, Phase 4 UI | Q6C-01–04/11/13/18 |
| Memory/contexts | Phase 2D privacy, Phase 3 context, Phase 4 memory | Q6C-12/16 |
| Research/AI quality | SRS AI quality; approved Phase 3 eval rubric, source provenance | Q6C-14/15/17/18/24 |
| Snapshot and evidence | Phase 2/4 API, Phase 5 storage | Q6C-21 |
| Deletion/restoration | Phase 2D + P5-AM01 approved amended contracts | Q6C-07–09/22 |
| Cost and budget | Phase 3 admission, Phase 5 no-paid default | Q6C-10/19 |
| Deployment/response | Phase 5 infra, Phase 6A test strategy, Phase 6B security tests | Q6C-19/20/22 |

**Phase 6D work:** Reconcile 6A–6C with approved latest SRS/OpenAPI/Prisma, strict AI output and current evaluated rubric, independent deletion-intent acceptance protocol, all Phase 2D/3/4/5 manifests; build a combined source-exact discrepancy register, quality gates, full test/eval coverage matrix and document-only sign-off readiness. Preserve any original scenario IDs. Avoid proposing new private monitoring data capture without explicit owner review.

## 15. Interview-ready architecture Q&A

**Q: Why do we need observability if we already have tests?** Tests assess expected behavior in controlled conditions; observability helps diagnose real system behavior and unknown production failures. Neither substitutes for a restore drill or a DB-backed correctness test.

**Q: Why not log all prompts to debug model issues?** Raw founder prompts may contain private business details. Use versioned synthetic fixtures, redacted error classes, hashes/correlation where justified, and consent-governed diagnostic collection instead.

**Q: Why doesn't a successful streamed answer mean the generation succeeded?** Live SSE fragments are provisional; only a guarded terminal database commit establishes the selected final answer.

**Q: How do we detect a deleted account that could reappear after restoration?** Establish an independent deletion-suppression authority and require proof of complete coverage before opening access; missing coverage is a blocking safety incident.

**Q: What makes an AI quality evaluation credible?** A versioned dataset and rubric, independent human review with disagreements recorded, hard safety gates, multiple model samples, provenance and regression evidence—rather than a single uncalibrated score.

---

**Phase 6C disposition:** Professional design draft prepared; not reconciled to the latest canonical repository, not owner-approved, no implementation, tests, model calls or monitoring infrastructure created. Phase 6D is next.


## Current repository reconciliation

Phase6D section16 supersedes historical source-unavailable/intake statuses and owns the current discrepancy register, API/requirements traceability and validation. Actual canonical path is Docs/lld/08-testing-quality/. Phase3 six-dimension0-2 rubric governs AI quality; privacy/security/cost/deletion failures are independent hard release blockers. Approved P5-AM01 distinguishes durable intent from committed deletion; unresolved suppression blocks access and restore, not merely alerts. Local-first Compose, deferred public demo/cloud, GitHub Actions proposed direction and founder development operator are inherited Phase5 decisions; actual eligibility/public incident responsibility remain pending. All runtime/database/browser/SDK/security/AI/recovery/performance scenarios remain Not Executed. No provider/tool is installed or selected. Candidate FL-P6-0.2-review - Not Approved; no Phase7 authorization.


## Current operational direction approvals

The owner explicitly approved the six Phase6 operational directions in this conversation. Phase6D section17 owns current decision references/dispositions and supersedes earlier pending-direction labels. Telemetry minimizes personal data with short documented retention, exact durations provisional; only authorized operators may access it, with access-audit evidence. Ordinary logs exclude founder prompts/message bodies, credentials, hidden AI context and private download grants, including automatic exceptions. Prefer minimal TypeScript-compatible tools, exact libraries/versions unselected. Browser plan covers Chromium,Firefox,WebKit plus real mobile/assistive technology when devices are available; unavailable combinations remain explicitly untested. All numerical thresholds require calibration and explicit acceptance. Founder owns development incidents; public roles/escalation must be assigned before launch. Directions are approved design only, not installed tools, secure operational storage, executed tests or final package approval. Candidate FL-P6-0.3-review - Not Approved. Existing security/privacy/deletion/spend hard gates and exact Phase3 six-dimension0-2 rubric remain binding. No frozen specification amendment or Phase7 work.


## Formal documentation approval - current status

FL-P6-0.3-approved - Approved, Documentation Only. Owner evidence is the explicit Phase6 formal documentation sign-off instruction in this conversation. No date/timestamp, signature or Git commit is inferred. Phase6D section18 and approved-revision-0.3.json govern current package status. Earlier pending/draft/review labels remain historical; no runtime finding is closed by approval. All database/migration/security/SDK/worker/restore/browser/accessibility/AI/performance/provider/cost-control verification remains Not Executed. Exact numerical targets remain provisional; AI-D14 remains accepted pending controlled HLD editorial amendment. No implementation, installation, spending, migration, test execution, monitoring provisioning, deployment or Phase7 authorization.
