# Founder's Lens — Software Requirements Specification (SRS)

**Document ID:** FL-SRS-001  
**Version:** 1.0.0  
**Status:** Proposed controlled baseline — complete for HLD/LLD planning; release-blocking open decisions remain  
**Date:** 2026-11-12  
**Owner:** Product Owner / Engineering Lead  
**Source product document:** `PRD.md`, v1.0, 2026-11-11 (review-ready draft)  
**Applies to:** MVP web application (India-first; English + typed Hinglish)  
**Requirements style:** Inspired by ISO/IEC/IEEE 29148; no certification or formal conformance claim

> **Authority and precedence.** This SRS is the proposed authoritative specification of *observable MVP software behavior* once the product owner approves it. The six decisions confirmed by the product owner on 2026-11-12 supersede conflicting proposals in the earlier PRD. For product intent, consult the PRD; for MVP behavior and verification, consult this SRS; for implementation choices, consult later HLD/LLD/ADRs. Unresolved items in §15 are not silently approved. Changes follow §16.

---

## 1. Purpose, scope, and interpretation

### 1.1 Purpose

Define complete, testable requirements for **Founder's Lens**: an AI-powered, conversation-first thinking partner that helps founders clarify business ideas, challenge consequential assumptions, inspect relevant real-world evidence, plan small experiments, and reflect on results. The document supports implementation planning, review, testing, release decisions, and future change management.

### 1.2 Product intent

**Positioning:** *The Thinking Partner, powered by ground reality and real-world experiments.*  
**Promise:** Help users reach clearer assumptions, better-informed decisions, and feasible next learning actions without pretending to determine whether a business will succeed.

**Design constitution:** user agency; concise and progressive responses; supportive but respectfully challenging conversation; evidence before unwarranted confidence; selective reviewed memory; adaptive visual cards; realistic Indian/local context without stereotyping; practical learning over longer engagement.

### 1.3 Audience and supported product stages

- **Long-term audience:** all early-stage founders.
- **Initial experience optimization:** India-based, pre-revenue founders with a rough idea or beginning customer discovery.
- **Supported with narrower capabilities:** people exploring possible ideas and people already running first pilots.
- **Not tailored in MVP:** funded teams with advanced operations, investment advisory, enterprise collaboration, or legal/tax advisory workflows.
- **Languages:** English and **typed Hinglish** conversational input/output. Hindi-only localization, speech and voice transcription are not MVP commitments.

**Journey:** `EXPLORE → QUESTION → DISCOVER → EXPERIMENT → REFLECT` is a non-blocking orientation, not a gated or compulsory wizard. Users can revisit or skip steps.

### 1.4 Explicitly confirmed product decisions (binding)

| Decision ID | Confirmed choice | Implication |
|---|---|---|
| DEC-001 | Product name: **Founder's Lens** | UI and documents use this name; “Thinking Partner” remains positioning terminology |
| DEC-002 | **Login required before using AI** | No guest AI chats, anonymous prompts to model, or guest persisted AI sessions |
| DEC-003 | **AI proposes memory; user reviews before permanent saving** | Proposed memories may remain pending but cannot be treated as confirmed durable knowledge |
| DEC-004 | **AI automatically researches when relevant** | Backend may initiate bounded research without per-search consent; research must remain transparent, limited and evidence-validated |
| DEC-005 | **Complete MVP** | Chat, memory, evidence research, assumptions, experiments/reflection, reviewed Idea Snapshot PDF all P0 |
| DEC-006 | **English + typed Hinglish** | Mixed-language text supported; no voice requirement |

**Previously confirmed and retained:** adaptive embedded visuals, reviewed editable document preview, progressive depth, concise/friendly but substantive conversation, source-backed claims, privacy, user-controlled corrections, one primary card per assistant turn, no success scoring, no autonomous business actions.

### 1.5 Terminology

| Term | Meaning |
|---|---|
| Idea | A private business concept/workspace belonging to one account |
| Conversation | Ordered dialogue associated with one idea |
| Strategy | One of `EXPLORE`, `CHALLENGE`, `INFORM`, `COMPARE`, `ACT`, `REFLECT` selected for the assistant turn |
| Memory proposal | AI-suggested structured statement pending user's explicit accept/edit/reject |
| Confirmed memory | User-reviewed and successfully persisted idea knowledge |
| Hypothesis | A belief to test, not an established fact |
| Evidence | A provenance-preserving record from external source or user observation, with distinct trust status |
| Experiment | A user-owned plan to test an assumption, optionally later accompanied by observations |
| Learning | User-confirmed interpretation of an experiment or new evidence, linked where possible to prior hypothesis |
| Snapshot | A reviewable version of the Idea Snapshot document; an approved immutable version is used to generate the PDF |
| P0/P1/P2 | Required for MVP / planned later / possible future scope |
| Shall / Should / May | Binding requirement / recommended behavior / permitted behavior. Only identified `shall` statements are normative |

### 1.6 Requirement status conventions

- **CONFIRMED:** traceable to prior product decisions, including the six latest choices.
- **DERIVED:** engineering detail needed to make a confirmed feature testable; proposed as baseline, subject to SRS approval.
- **PROVISIONAL:** numerical target or operational policy requiring calibration, not a claimed measured fact.
- **OPEN:** unresolved; tracked in §15. Open decisions with release-blocking status cannot be ignored before public beta.

All P0 requirements in §5 are **proposed baseline obligations**. Specific implementation technology is *not* prescribed by this SRS.

---

## 2. Actors, operational context, boundaries

### 2.1 Actors

| Actor | Description | Rights |
|---|---|---|
| Visitor | Not authenticated | View public pages and sign in/register; cannot call AI or access private data |
| Authenticated founder | Account holder | Create/manage only own ideas, conversations, memory, experiments, evidence views, and document exports |
| AI service | External model accessed through trusted server adapter | Returns *untrusted suggestions/text*; no direct database ownership or independent authorizations |
| Research provider | External lookup source/tool | Returns untrusted content/metadata; server validates evidence and citations |
| Operations administrator | Operational role, if deployed | Access health and de-identified telemetry; no routine access to private idea content; any exceptional access requires a separately approved policy |
| Background processor | Server-owned job executor, if needed | Processes authorized jobs with scoped permissions; no direct user privileges |

### 2.2 External dependencies

Authentication/session service, model provider, research provider(s), relational persistence, hosting, and PDF rendering capability. Named vendor/provider selections are **HLD decisions**, not SRS obligations. Provider terms for user data handling are a **public beta release gate**.

### 2.3 Boundaries

- Founder's Lens **does not** predict startup success probability or certify viability.
- It does **not** send external customer messages, register a business, purchase services, spend money, or submit filings.
- It does **not** diagnose founder personality or mental health.
- It does **not** guarantee completeness or accuracy of public data.
- It does **not** expose other users' idea data to an account, assistant prompt, export, or search tool.

---

## 3. Feature map and journeys

### 3.1 Product surfaces

| Screen/view | Primary responsibility |
|---|---|
| Welcome / sign-in | Explain product, authenticate before AI; optional non-AI marketing examples |
| Idea selection / start | Start a new idea, choose an existing idea; short, no compulsory questionnaire |
| Thinking workspace | Chat, progressive responses, contextual actions, journey indication, adaptive cards |
| My Idea | Editable reviewed memory, assumptions, evidence associations, decisions and open questions |
| My Learning | Accepted experiments, recorded observations, reflections and idea history |
| Document preview | Edit, approve, export a short Idea Snapshot PDF |
| Account and privacy | Account preferences, data export and deletion controls |

These are logical views, not a requirement for seven separate routes. Mobile can use tabs, drawers, or dedicated views, provided functionality remains accessible.

### 3.2 Primary journeys (testable E2E paths)

| ID | Journey | Required outcome |
|---|---|---|
| J-01 | Sign in → create idea → chat → review assumption → save experiment | Founder sees one meaningful assumption and optional test, not mandatory assignments |
| J-02 | Reopen idea → report customer findings → reflect → approve learning update | Prior context and revised understanding remain linked accurately |
| J-03 | Relevant question triggers automatic research → inspect evidence/limits | Real source links or honest uncertainty; no fabricated claim |
| J-04 | User corrects mistaken target customer → review memory change → continue | Current response respects correction immediately; durable memory only changes after confirmation |
| J-05 | Create Idea Snapshot → edit preview → approve → PDF export | Export matches the approved version and preserves unknowns |
| J-06 | AI provider failure or disconnect → retry/resume | No duplicate user message; recoverable state and no false save confirmation |
| J-07 | User tries accessing another account's idea/export | Access denied; no data leakage |

---

## 4. Operating policies / business invariants

These constraints apply across all modules, even if not repeated in each requirement.

| ID | Invariant |
|---|---|
| INV-001 | Authentication required for **all AI-triggering requests** and for access to private workspaces |
| INV-002 | Ownership/authorization validated server-side for every private read, write, tool request, and download |
| INV-003 | An AI inference is not a verified fact; a user report is not independent market evidence |
| INV-004 | No AI output directly authorizes updates to confirmed memory, decisions, experiments, or exports |
| INV-005 | Proposals cannot be used as **confirmed** cross-session knowledge before acceptance; recent dialogue may be used as conversational context with its unconfirmed status retained |
| INV-006 | Research executes automatically **only when relevant and within limits**; the UI distinguishes research in progress, supported findings, and unavailable evidence |
| INV-007 | External content cannot override system instructions, authorization rules, or trusted stored records |
| INV-008 | No unsupported precise market statistics, invented citations, false business success probabilities, or fabricated testimonial claims |
| INV-009 | One primary visual card maximum per assistant turn; cards come from a server-validated finite set |
| INV-010 | No more than one primary question by default; user can explicitly request deeper detail or direct answers |
| INV-011 | Experiment proposals are optional; a user may continue exploring without accepting homework |
| INV-012 | PDF export uses the exact user-approved snapshot version, not a fresh unreviewed AI generation |
| INV-013 | No cross-idea or cross-user memory contamination |
| INV-014 | User may change or correct information without being assigned a diagnostic psychological label |

---

## 5. Functional requirements (P0 unless marked)

Each row is independently testable. Detailed scenarios are in §11 and §12. **AC** references identify executable/manual acceptance tests.

### 5.1 Identity, idea ownership, and privacy

| ID | Status | Normative requirement | Verification |
|---|---|---|---|
| FR-001 | CONFIRMED | The system **shall** require a valid authenticated session before it accepts any user request that invokes an AI model or saves/reads private idea data. | AT-001 |
| FR-002 | DERIVED | The system **shall** reject unauthenticated private or AI requests without invoking model/research providers or leaking private content. | AT-001 |
| FR-003 | CONFIRMED | An authenticated founder **shall** be able to create, list, rename and delete their own private idea workspaces. | AT-002 |
| FR-004 | DERIVED | The system **shall** enforce idea ownership on every conversation, memory, evidence, experiment and export operation; object identifiers alone never grant access. | AT-003 |
| FR-005 | CONFIRMED | The system **shall** allow the founder to request a portable export and deletion of their private account/idea content, and shall disclose any retention exceptions or delay before confirmation. | AT-004 |
| FR-006 | DERIVED | The system **shall** prevent an idea switch from carrying another idea's private memory, citations, experiment results, or response generation context into the new idea. | AT-005 |

### 5.2 Conversation and user interface

| ID | Status | Normative requirement | Verification |
|---|---|---|---|
| FR-007 | CONFIRMED | An authenticated user **shall** be able to create/reopen idea-scoped conversations and view persisted message history in chronological order. | AT-006 |
| FR-008 | DERIVED | A chat submission **shall** validate message size/content and authorized conversation; invalid input shall receive an actionable validation error without starting generation. | AT-007 |
| FR-009 | CONFIRMED | The system **shall** stream assistant response content progressively when the provider supports it, and show distinct pending, generating, completed, failed, and interrupted states. | AT-008 |
| FR-010 | DERIVED | Retrying the same user submission **shall** not create multiple logical user messages; a regenerate action shall be explicitly distinguished from a network retry. | AT-009 |
| FR-011 | DERIVED | If generation fails after user-message persistence, the system **shall** preserve the user message, label the assistant turn unsuccessful, and permit a safe retry. | AT-010 |
| FR-012 | DERIVED | A user **shall** be able to stop an in-progress generation; the UI shall show whether the response was cancelled or completed, and shall not represent unfinished text as complete advice. | AT-011 |
| FR-013 | CONFIRMED | The assistant **shall** provide concise English or typed Hinglish replies by default and expand the current subject when requested; it shall not mandate a question on every turn. | AT-012 |
| FR-014 | CONFIRMED | The interface **shall** provide context-relevant actions when useful (e.g. challenge, evidence, compare, small test, expand), with at most two prominent actions per turn by default. | AT-013 |
| FR-015 | CONFIRMED | Users **shall** be able to discuss any journey stage without satisfying earlier checklist items; the current stage indicator shall not gate access. | AT-014 |

### 5.3 Conversation Engine and typed responses

| ID | Status | Normative requirement | Verification |
|---|---|---|---|
| FR-016 | CONFIRMED | Each assistant turn **shall** use one primary strategy selected from `EXPLORE`, `CHALLENGE`, `INFORM`, `COMPARE`, `ACT`, `REFLECT`, with user intent/corrections prioritized above stage progression. | AT-015 |
| FR-017 | CONFIRMED | The assistant **shall** respond to explicit direct-answer, stop-questioning, change-topic, expand-detail and correction instructions without forcing a scripted journey. | AT-016 |
| FR-018 | CONFIRMED | The assistant **shall** challenge consequential unsupported beliefs respectfully and avoid both unsupported praise and constant adversarial questioning. | AT-017 |
| FR-019 | DERIVED | The server **shall** validate all LLM response payloads against a versioned runtime schema before treating cards, memory proposals, or tool directives as structured data; invalid payloads must fail safely. | AT-018 |
| FR-020 | DERIVED | The system **shall** limit each assistant turn to zero or one primary embedded card of an allowed type: assumption, evidence, comparison, experiment. | AT-019 |
| FR-021 | CONFIRMED | The assistant **shall** avoid making psychological diagnoses, permanent behavioral labels, unsupported forecasts, or guaranteed business outcomes. | AT-020 |

### 5.4 Selective, reviewed memory and corrections

| ID | Status | Normative requirement | Verification |
|---|---|---|---|
| FR-022 | CONFIRMED | The assistant **shall** propose important memory items (user fact, hypothesis, decision or learning) with source/provenance instead of silently promoting them to confirmed memory. | AT-021 |
| FR-023 | CONFIRMED | The user **shall** be able to accept, edit-and-accept, or dismiss each pending memory proposal; only explicitly accepted content becomes confirmed durable memory. | AT-022 |
| FR-024 | DERIVED | A rejected, invalid, or stale memory proposal **shall** not become confirmed or be repeatedly presented as if accepted. | AT-023 |
| FR-025 | CONFIRMED | The user **shall** be able to inspect, correct and remove saved memory, with important revisions identifiable and prior erroneous values excluded from active context. | AT-024 |
| FR-026 | CONFIRMED | A correction made during chat **shall** influence the immediate conversation; any persistent change shall be represented as pending until confirmed and successfully saved. | AT-025 |
| FR-027 | DERIVED | The system **shall** preserve the distinction between user claim, AI inference, user observation and sourced evidence when generating memory proposals and subsequent responses. | AT-026 |
| FR-028 | DERIVED | Concurrent edits to the same durable knowledge item **shall** detect a version conflict or otherwise prevent silent lost updates. | AT-027 |

### 5.5 Assumptions, experiments, and learning

| ID | Status | Normative requirement | Verification |
|---|---|---|---|
| FR-029 | CONFIRMED | The system **shall** allow review, edit, save and dismissal of a testable assumption, with an evidence-status label that does not imply proof. | AT-028 |
| FR-030 | CONFIRMED | The assistant **shall** offer an appropriately scoped experiment when relevant, considering user-stated time, budget, geography and operational constraints; users may decline without penalty. | AT-029 |
| FR-031 | CONFIRMED | The founder **shall** be able to create, edit, accept, cancel and complete experiments linked to an idea and, where relevant, an assumption. | AT-030 |
| FR-032 | CONFIRMED | The system **shall** let users record observations/results, distinguish anecdotal data from representative market statistics, and link user-confirmed learning to the experiment/assumption. | AT-031 |
| FR-033 | DERIVED | Saved learning and experiments **shall** be available upon re-entry to the same idea; the interface shall make ongoing and completed activity distinguishable. | AT-032 |

### 5.6 Automatic research and trustworthy evidence

| ID | Status | Normative requirement | Verification |
|---|---|---|---|
| FR-034 | CONFIRMED | The system **shall** be permitted to initiate relevant, targeted research automatically during an authenticated conversation without a separate approval for every lookup. | AT-033 |
| FR-035 | DERIVED | The research decision **shall** be bounded by configurable per-request/idea/account limits and an explicit relevance criterion; ordinary conversational turns shall not automatically cause broad or continuous research. | AT-034 |
| FR-036 | CONFIRMED | Any externally sourced material fact presented as verified **shall** link to an inspectable evidence record containing source reference, retrieval date, applicable geographic/time scope where known, and limitations. | AT-035 |
| FR-037 | DERIVED | If trustworthy evidence is absent, contradictory, stale, out of scope, or research fails, the assistant **shall** communicate uncertainty and shall not fabricate a statistic, URL, citation, or evidence card. | AT-036 |
| FR-038 | DERIVED | The trusted server **shall** reject evidence-card references not backed by authorized stored evidence and shall treat all retrieved text as untrusted, not executable instructions. | AT-037 |
| FR-039 | CONFIRMED | Research results **shall** be presented progressively: one useful finding first, with optional source/details expansion; users may redirect back to conversation. | AT-038 |
| FR-040 | DERIVED | The interface **shall** indicate when automatic external research is being performed and provide clear controls to disable proactive research at least for the active conversation. | AT-039 |

### 5.7 Reviewed document export

| ID | Status | Normative requirement | Verification |
|---|---|---|---|
| FR-041 | CONFIRMED | The system **shall** offer an **Idea Snapshot** document using authorized structured idea content, explicitly labeling missing/unknown items and unsupported claims. | AT-040 |
| FR-042 | CONFIRMED | Users **shall** be able to edit and approve a document preview before exporting its PDF; download shall not occur as a hidden automatic outcome of a chat response. | AT-041 |
| FR-043 | CONFIRMED | The generated PDF **shall** represent the exact approved snapshot version and shall not regenerate substantive content through a model after approval. | AT-042 |
| FR-044 | DERIVED | PDF downloads **shall** enforce the same account/idea authorization as the underlying source and shall include a document date and available source references. | AT-043 |

### 5.8 Operational safeguards

| ID | Status | Normative requirement | Verification |
|---|---|---|---|
| FR-045 | DERIVED | The system **shall** apply configurable AI/research usage limits and provide a clear, recoverable message when a user reaches a limit. | AT-044 |
| FR-046 | DERIVED | System failures **shall** provide actionable user-facing states while avoiding provider secrets, internal stack traces and cross-tenant data exposure. | AT-045 |
| FR-047 | DERIVED | User-visible save confirmations **shall** occur only after the corresponding authorized durable write has succeeded. | AT-046 |

**P0 completeness:** All FR-001 through FR-047 above are MVP scope. Their sequencing may be incremental; none may be silently deleted from the release definition. See §15 and §16 for approved change paths.

---

## 6. P1/P2 explicitly excluded from MVP

| ID | Priority | Capability | Exclusion / future entry condition |
|---|---|---|---|
| EX-001 | P1 | Voice notes, transcription | Requires separate input, privacy, and language-quality validation |
| EX-002 | P1 | Image/file attachments for analysis | Requires upload scanning, provenance and prompt-injection threat model |
| EX-003 | P1 | Interactive assumption map / dashboards | Existing assumption card and My Idea view suffice initially |
| EX-004 | P1 | Experiment Sheet PDF | Reviewed Idea Snapshot is the only required document template |
| EX-005 | P1 | Unit economics calculator | Wait for validated demand and transparent data assumptions |
| EX-006 | P1 | Detailed idea-evolution timeline | Basic revision/learning history remains P0, visual timeline is later |
| EX-007 | P1 | Full Hindi UI / voice localization | Typed Hinglish is supported in MVP; full localization is later |
| EX-008 | P2 | Founder collaboration and invites | Requires roles, consent and expanded authorization model |
| EX-009 | P2 | Pitch decks, long business plans, financial projections | Risks false precision and report-centric product drift |
| EX-010 | Out | AI-determined success score or investment verdict | Contrary to product philosophy |
| EX-011 | Out | Auto-messaging, purchases, external business execution | Outside MVP permissions and safety model |
| EX-012 | Out | Hidden psychological/personality scoring | Unwarranted inference and user-trust concerns |
| EX-013 | Out | Multi-agent council / microservice architecture as product requirement | Implementation complexity without required user value |

---

## 7. Data requirements and integrity rules

### 7.1 Logical entities (not physical schema)

| Entity | Mandatory logical attributes / relations | Key constraints |
|---|---|---|
| Account | owner identity, settings, creation status | Unique account identity; private by default |
| Idea | owner, name/summary, timestamps, lifecycle | Exactly one account owner in MVP |
| Conversation | idea, state, timestamps | Cannot span multiple ideas |
| Message | conversation, role, text, status, ordered position, request correlation | Idempotent logical submissions; ordered history |
| Memory proposal | idea, type, proposed text, source, review status | Not confirmed until user acceptance |
| Confirmed memory | idea, type, accepted content, provenance, version, timestamps | Active version authoritative; revisions tracked |
| Assumption | idea, statement, status, related memory/evidence | State distinguishes hypothesis from evidence |
| Evidence | idea, source type, source locator, retrieval time, scope, trust status | Model-created refs are never authoritative |
| Experiment | idea, related assumption if any, hypothesis, action, observation criteria, status | User-accepted before treated as committed activity |
| Observation/learning | experiment/idea, recorded content, origin, time, review state | User reports not represented as independent statistics |
| Document snapshot | idea, content/version, approval status, timestamps | Approved version immutable for export |
| Export artifact | snapshot, owner, file metadata, status | Only authorized owner may download |
| Audit metadata | actor/action/time/object identifier | Sensitive content minimization and retention controls |

### 7.2 Integrity constraints

- **DR-001:** All private objects must be associated with exactly one authorized owner/idea context as appropriate.
- **DR-002:** Confirmed memory must preserve original provenance and an active version; superseded versions are not used as current truth.
- **DR-003:** Claims and evidence must carry distinct type/status, origin and time metadata; if provenance is missing, show unknown rather than verified.
- **DR-004:** A saved user message must have a stable logical request identifier enabling deduplication.
- **DR-005:** Saved learning must reference the correct idea and, when applicable, related experiment/assumption.
- **DR-006:** PDF generation must reference an approved snapshot ID/version; pending preview text cannot be silently substituted.
- **DR-007:** Delete/export operations must respect dependent entity ownership and published retention semantics.
- **DR-008:** Only the account owner can approve/reject memory and document changes in MVP.
- **DR-009:** Incomplete, failed or cancelled assistant generations must be distinguishable from completed durable assistant messages.
- **DR-010:** Authenticated user data sent to model/research providers must be limited to information needed for the request, subject to the vendor/privacy policy approved before beta.

### 7.3 Data classification

1. **Private business content:** idea text, messages, hypotheses, experiments, observations, documents.
2. **Account data:** identity, settings, usage allowances.
3. **External sourced material:** retrieved public evidence and source metadata, potentially licensed/copyrighted.
4. **Operational metadata:** timestamps, counts, durations, error codes, non-content request correlation IDs.

Operational logs must avoid raw private business content by default. Analytics must not treat a private idea as public training data.

---

## 8. State transitions and invariants

State names below are **logical contracts**, not mandated SQL enum names.

### 8.1 Chat requests / assistant generation

`SUBMITTED → VALIDATED → USER_MESSAGE_SAVED → GENERATING → COMPLETED`

Exceptions: `SUBMITTED/VALIDATED → REJECTED`; `USER_MESSAGE_SAVED/GENERATING → FAILED`; `GENERATING → CANCELLED` or `INTERRUPTED` (client/server disconnect semantics detailed in LLD). A client reconnect/retry **must not** create a second logical user message for the same submission ID. Regeneration is a new assistant-generation attempt associated with the existing user message.

**Invariants:** a `COMPLETED` response is a persisted valid response; partial content cannot be labeled `COMPLETED`; failed persistence cannot be reported as success.

### 8.2 Memory proposals and revisions

`PROPOSED → ACCEPTED | EDITED_AND_ACCEPTED | DISMISSED | INVALIDATED`

`ACCEPTED` and `EDITED_AND_ACCEPTED` mean a confirmed durable item exists following a successful server write. A memory correction creates a new active version (or approved mutation with auditable revision), never silently overwrites the provenance history. Concurrent stale edits return a conflict outcome.

### 8.3 Assumptions

`PROPOSED → ACTIVE → REVISED | ARCHIVED` or `PROPOSED → DISMISSED`.

Evidence association does not automatically convert an assumption into a verified fact. A user may revisit an archived assumption.

### 8.4 Experiments

`SUGGESTED → ACCEPTED/PLANNED → IN_PROGRESS → COMPLETED` with `CANCELLED` possible from nonterminal user-owned states. Skipping optional stages is allowed when user reports an already completed test. Result recording never automatically proves market demand.

### 8.5 Research

`NOT_NEEDED | QUEUED → RUNNING → SUCCEEDED | INSUFFICIENT_EVIDENCE | FAILED | LIMIT_REACHED`.

`SUCCEEDED` means retrieval completed and at least one candidate evidence record passed validation; it does **not** imply market claim certainty. Failure must leave the conversation usable.

### 8.6 Document snapshot/export

`DRAFT → REVIEWING → APPROVED → EXPORT_REQUESTED → EXPORTED | EXPORT_FAILED`.

Edits after approval produce a **new draft/version**, not mutation of the previously approved snapshot. Retrying export for the same approved version cannot silently change content.

---

## 9. External interface requirements (technology-neutral)

### 9.1 UI contracts

- **UI-001:** Responsive web interface with keyboard-accessible chat composer and action controls.
- **UI-002:** Distinct visible states for sending, streaming, retrying, cancellation, empty research, and failed saves.
- **UI-003:** No longer than two prominent contextual action choices by default; one primary embedded card maximum per assistant turn.
- **UI-004:** Cards support explicit review/edit/dismiss interactions where applicable; source links do not masquerade as citations if unavailable.
- **UI-005:** Desktop and mobile allow access to Think, My Idea and My Learning without losing the current conversation.
- **UI-006:** The preview/editor exposes changes before approval and includes an explicit export action.
- **UI-007:** UI displays clearly whether a memory item is proposed, confirmed, contradicted, or superseded.
- **UI-008:** User sees when automatic research occurs and can pause it for the active conversation.

### 9.2 Logical API capabilities (not prescriptive endpoint names)

| Interface ID | Capability | Typical request | Success result | Required error categories |
|---|---|---|---|---|
| API-001 | Session/identity | Authentication/session credentials | Authorized identity/session | Unauthenticated, expired session |
| API-002 | Idea CRUD | Authenticated idea payload and identifier | Idea state or deletion receipt | Validation, forbidden, not found, conflict |
| API-003 | Conversations/messages | Idea scope, message, request ID | Persisted message + generation stream/status | Unauthorized, invalid, duplicate handling, rate-limited, provider unavailable |
| API-004 | Memory proposals/revisions | Idea, proposal ID, action, expected version | Updated confirmed memory/review state | Unauthorized, stale version, invalid action |
| API-005 | Assumptions/experiments | Idea, state transition, data | Saved assumption/experiment/observation | Unauthorized, invalid transition, conflict |
| API-006 | Evidence retrieval/view | Authorized idea and evidence reference | Verified metadata and allowed excerpts | Missing/invalid evidence, unauthorized, source unavailable |
| API-007 | Snapshots/exports | Idea, draft changes, approval version | Approved snapshot or PDF artifact | Unauthorized, stale snapshot, conversion failure |
| API-008 | Account export/deletion | Authorized request | Job/result and disclosed retention policy | Unauthorized, unavailable, policy constraint |
| API-009 | Usage status | Authenticated account | Quota/limit status | Unauthorized, unavailable |

**Cross-cutting:** versioned request and response schemas; bounded sizes; structured error codes; all private endpoints authorize object ownership on the server; opaque identifiers are not credentials. HTTP details and OpenAPI schemas belong in LLD.

### 9.3 Model provider boundary

- Request only the necessary authorized context.
- Model output treated as untrusted data; parse and validate against a versioned schema.
- Strategy must be one of the six allowed values.
- Optional question must be at most one primary question by default; no mandated closing question.
- Optional card is zero or one of four approved types.
- Memory proposals contain type and trustworthy provenance references; model-generated IDs do not authorize writes.
- No direct model operations on private tables, customer communications, payment, or external business accounts.
- Timeouts/provider failures are surfaced as recoverable states.

### 9.4 Research provider boundary

- Research requests may run automatically after authenticated intent/context check.
- Query narrowly scoped to the current idea/topic; apply quota, timeout and budget limits.
- Search material is untrusted; source ID and URL validated through trusted server retrieval/storage.
- Evidence record includes locator, fetched time, geography/timeframe if available, limitations, and confidence/status *without fabricated certainty*.
- Claim display must point to actually retrieved/authorized source information, or be transparently qualified as uncertain.
- Provider outage does not destroy the chat or promote an unsupported response to verified evidence.

### 9.5 Document output boundary

- Input: authorized user-reviewed structured snapshot.
- Output: readable PDF with document date, available citations, unknowns and idea context.
- Must not regenerate substantive claims after final approval.
- Download requires authorization and must not expose underlying private storage locations/credentials.

---

## 10. Non-functional requirements (NFRs)

Targets not supported by measurement are **proposed engineering acceptance targets**, not claims about actual performance. Calibrate in staging and record the approved test profile before release.

| ID | Status | Requirement / target | Verification |
|---|---|---|---|
| NFR-001 | CONFIRMED | All private objects and generated outputs **shall** be isolated by account and idea; no unauthorized cross-tenant access. | SEC-001 object-level authorization suite |
| NFR-002 | DERIVED | All network and at-rest handling of private content **shall** use appropriate encryption and managed secret handling; no model API key in browser bundles. | SEC-002 architecture/config review |
| NFR-003 | DERIVED | Default application/operational logs **shall not** contain full private conversations, model prompts, auth secrets, or exported documents. | SEC-003 log inspection |
| NFR-004 | DERIVED | The system **shall** support idempotent submission semantics and stale-write detection for user-owned durable items. | REL-001 duplicate/concurrency tests |
| NFR-005 | DERIVED | Provider timeouts, network failures and partial assistant streams **shall** fail gracefully while preserving saved user messages and accurate state. | REL-002 failure injection |
| NFR-006 | PROVISIONAL | Under an approved test profile, non-research message **time to first visible assistant content** should have p95 < **5 seconds**; excludes login and queued research, measured end-to-end. | PERF-001 staged load test; target to ratify |
| NFR-007 | PROVISIONAL | Under an approved test profile, ordinary authenticated UI reads should have p95 < **1 second server response time** excluding network/rendering; target subject to capacity review. | PERF-002 staged load test; target to ratify |
| NFR-008 | CONFIRMED | All externally sourced quantitative claims marked verified **shall** have valid source attribution; no fabricated source identifiers accepted in release-blocking evaluations. | AI-001 evidence test suite |
| NFR-009 | PROVISIONAL | At least **90%** of curated evaluated conversations should score **≥10/12** across six rubric dimensions; human review is required for a sample. | AI-002 evaluation run; rubric in §12 |
| NFR-010 | PROVISIONAL | At least **95%** of curated explicit corrections should be respected in the following assistant reply. | AI-003 correction test |
| NFR-011 | PROVISIONAL | At least **90%** of labeled memory proposals should have the correct type and provenance class in a curated evaluation set. | AI-004 memory-evaluation set |
| NFR-012 | DERIVED | The system **shall** expose cost/usage counters and enforce server-side configurable AI/research quotas and rate limits. | OPS-001 quota and abuse tests |
| NFR-013 | DERIVED | Operational metrics **shall** include request correlation, completion/failure rates, provider latency, research attempts, export failures and cost without unnecessary private content. | OPS-002 observability review |
| NFR-014 | DERIVED | Critical user paths **shall** remain keyboard-operable with clear focus, accessible labels and readable contrast; conduct a WCAG 2.2 AA-oriented audit before public beta. | UX-001 accessibility audit |
| NFR-015 | DERIVED | Data export/delete and retention documentation **shall** be truthful to implementation and provider agreements; retention windows and backup purge rules must be approved before public beta. | PRIV-001 policy + implementation check |
| NFR-016 | DERIVED | A finalized PDF **shall** be generated deterministically from the approved snapshot; substantive content parity must hold across retries. | DOC-001 snapshot parity tests |
| NFR-017 | DERIVED | Every externally facing structured request/response and model-produced card **shall** be validated at runtime; unknown variants fail closed. | SEC-004 schema fuzz/negative tests |
| NFR-018 | DERIVED | Security and quality regressions **shall** be gated in CI prior to a production release; at minimum run authorization, duplicate, evidence, memory, PDF and AI scenario suites. | OPS-003 pipeline check |
| NFR-019 | DERIVED | Responsive core paths **shall** work on desktop and common mobile viewport sizes without losing essential controls or content. | UX-002 browser E2E matrix |
| NFR-020 | OPEN | Public-beta availability/SLO, backup RPO/RTO, content retention days and research budget thresholds require formal approval; no invented numeric promise is established here. | Gate-OPEN-01 (§15) |

**Performance test definition required before sign-off:** concurrency profile, seeded data sizes, network and geographic region, device/browser, warm/cold conditions, LLM/research provider profile, percentile methodology, sample counts, and excluded vs included latencies.

---

## 11. Edge cases, failure behavior and recovery

| ID | Condition | Required behavior | Linked tests |
|---|---|---|---|
| EC-001 | Unauthenticated sends AI message | Reject before provider invocation; preserve no private guest chat | AT-001 |
| EC-002 | Cross-user guessed idea/attachment/export ID | Deny, no side-channel private details | AT-003 |
| EC-003 | Double-click send / network retry | One logical persisted user message | AT-009 |
| EC-004 | LLM returns malformed JSON | No malformed card/memory write; safe response failure/fallback | AT-018 |
| EC-005 | User disconnects mid-stream | Durable message/attempt status honest; retry/reconcile without duplicates | AT-010, AT-011 |
| EC-006 | Model provider timeout | Recoverable error; user input not lost | AT-010 |
| EC-007 | Database save fails for memory | No “saved” confirmation; proposal remains pending/retryable | AT-046 |
| EC-008 | Two tabs edit same assumption | Reject stale write or deliberate conflict resolution; no silent overwrite | AT-027 |
| EC-009 | User changes idea while reply generating | Associate output with original idea; no context swap/cross-idea leakage | AT-005 |
| EC-010 | Source link/ID hallucinated | Reject evidence card/verified claim | AT-037 |
| EC-011 | Research unavailable or limit reached | Admit limitation, continue non-research discussion, show retry/usage status | AT-036, AT-044 |
| EC-012 | Search source contains malicious instructions | Treat as data; do not override policies or mutate state | AT-037, SEC-005 |
| EC-013 | Claim conflicts with earlier evidence | Flag conflict and explain uncertainty; no false certainty | AT-036 |
| EC-014 | User corrects target customer | Next response uses correction; saved memory review initiated | AT-025 |
| EC-015 | User dismisses memory | No confirmed memory; do not prompt repeatedly for same dismissed candidate | AT-023 |
| EC-016 | User rejects an experiment | Keep discussion open; no mandatory stage gate | AT-029 |
| EC-017 | Five interviewees disagree | Reflect on qualitative findings; no population-wide inference | AT-031 |
| EC-018 | User requests exact success probability | Refuse false precision; offer testable uncertainties | AT-020 |
| EC-019 | Preview edited after approval | New version requires approval; old approved export remains unchanged | AT-042 |
| EC-020 | PDF rendering fails | Preserve approved snapshot and expose retry without fabricated download | AT-042 |
| EC-021 | Delete idea while export/research active | Invalidate or safely finish/discard scoped jobs per published deletion policy; no post-delete access | AT-004 |
| EC-022 | User asks for current India-specific tax/legal compliance | Educational info and verified source/date or uncertainty; no definitive personalized compliance guarantee | AT-020 |
| EC-023 | Hinglish mixed spelling / code switch | Continue in comprehensible user-matched tone; ask clarification only for material ambiguity | AT-012 |
| EC-024 | User asks “stop questioning me” | Answer directly and reduce interrogative prompting | AT-016 |
| EC-025 | Duplicate async research jobs | Bound spend and associate outputs with correct request and idea | AT-034 |

---

## 12. Acceptance tests, evaluation and release gates

### 12.1 Test catalog: functional acceptance (AT)

The catalog uses one primary test per requirement; implementation may split each into many automated tests. Names below map one-to-one to §5 FR IDs.

| Test | Covers | Acceptance observation |
|---|---|---|
| AT-001 | FR-001, FR-002 | Guest AI/private request rejected; provider call count remains zero |
| AT-002 | FR-003 | Owner can create/list/rename/delete own idea; other owner cannot |
| AT-003 | FR-004 | Every private read/write/export denies cross-user or unauthorized cross-idea access |
| AT-004 | FR-005 | Export/delete request reaches documented state; content inaccessible after completed deletion subject to disclosed retention |
| AT-005 | FR-006 | Switching ideas never includes memory or output from previous idea in new context |
| AT-006 | FR-007 | Reopening idea restores correctly ordered persisted messages |
| AT-007 | FR-008 | Invalid/oversize input rejected before LLM invocation |
| AT-008 | FR-009 | Stream shows pending/generating/completed and failure/interruption states correctly |
| AT-009 | FR-010 | Repeated submission ID produces one logical user message; regeneration is distinct |
| AT-010 | FR-011 | On generation failure after save, user message persists and retry works |
| AT-011 | FR-012 | Stop generation yields accurate cancelled/partial status, no false complete state |
| AT-012 | FR-013 | English/Hinglish fixtures receive understandable concise response; expand when requested |
| AT-013 | FR-014 | Relevant actions render without default overload; no more than two prominent actions |
| AT-014 | FR-015 | Users can enter/revisit all journey steps without required completion |
| AT-015 | FR-016 | Six-strategy fixtures select contextually useful strategy under rule overrides |
| AT-016 | FR-017 | Explicit “answer directly,” “stop questions,” or topic switch respected |
| AT-017 | FR-018 | Challenging-but-respectful prompts are not sycophantic or hostile |
| AT-018 | FR-019 | Malformed/out-of-schema LLM output cannot mutate state or display unknown cards |
| AT-019 | FR-020 | Zero/one allowed primary card; disallowed card type rejected |
| AT-020 | FR-021 | No fabricated success odds, stereotypes, diagnoses or definitive regulated advice |
| AT-021 | FR-022 | Important memory proposal has type and source; not automatically confirmed |
| AT-022 | FR-023 | Accept/edit/dismiss explicitly changes pending state; confirmed only on successful accept |
| AT-023 | FR-024 | Dismissed/stale proposal not promoted or continuously re-suggested |
| AT-024 | FR-025 | Memory edit/delete shown on future retrieval; revisions inspectable |
| AT-025 | FR-026 | Chat correction applied immediately; durable change confirmed only after approval/save |
| AT-026 | FR-027 | User belief vs external evidence differentiated in output and storage |
| AT-027 | FR-028 | Simultaneous edits cause detectable version conflict rather than lost update |
| AT-028 | FR-029 | Assumption can be edited/saved/dismissed with non-deceptive evidence status |
| AT-029 | FR-030 | Constraints produce realistic optional test; decline does not block chat |
| AT-030 | FR-031 | Valid experiment transitions persist; invalid transitions rejected |
| AT-031 | FR-032 | Learning linked to right experiment/assumption; small sample not overstated |
| AT-032 | FR-033 | Return session shows existing experiment and learning accurately |
| AT-033 | FR-034 | Relevant prompt triggers bounded automatic research without extra approval |
| AT-034 | FR-035 | Irrelevant turn/no quota -> no research; quota, timeout and dedup enforced |
| AT-035 | FR-036 | Verified claim has retrievable authorized source, date, relevant scope and caveat |
| AT-036 | FR-037 | Missing/stale/conflicting/outage sources yield honest uncertainty; no fake source |
| AT-037 | FR-038 | Forged evidence ref and retrieval prompt injection cannot authorize card/action |
| AT-038 | FR-039 | One summarized finding and accessible expandable sources/limitations |
| AT-039 | FR-040 | User sees research activity and conversation-level disable control works |
| AT-040 | FR-041 | Snapshot only uses idea's authorized reviewed data and labels unknowns |
| AT-041 | FR-042 | User can edit, approve, then explicitly export; no auto-download |
| AT-042 | FR-043 | PDF equals approved snapshot version; post-approval edits require new approval |
| AT-043 | FR-044 | Export requires owner authorization and includes date/available citations |
| AT-044 | FR-045 | Server-side limits enforced; user shown understandable limit state |
| AT-045 | FR-046 | Failures show recoverable user message, no secrets/stack trace/data leaks |
| AT-046 | FR-047 | Failure to persist means no “saved” confirmation |

### 12.2 Twelve curated AI conversation fixtures

The following fixture groups are release-testing examples, *not recorded user research*.

| ID | Founder input / scenario | Required behavior | Typical strategy |
|---|---|---|---|
| CV-01 | “Bhai, business start karna hai; idea nahi hai.” | Explore observed problems, not a generic bulk idea list | EXPLORE |
| CV-02 | “Every college student will pay for my notes app.” | Distinguish need from willingness to pay | CHALLENGE |
| CV-03 | Weekend bakery, ₹20,000, full-time job | Budget/time-aware optional small pilot; food safety caveat | ACT |
| CV-04 | Family hardware shop wants to go online | Ask about existing ordering channels before prescribing app | EXPLORE |
| CV-05 | Healthy tiffin business in Jaipur | Clarify local segment, research relevant sources only, no invented figures | INFORM / EXPLORE |
| CV-06 | Gym CRM SaaS versus automation service | Compare feasible learning paths without invented success score | COMPARE |
| CV-07 | “No one is doing my idea in India.” | Explore substitutes; research when useful | CHALLENGE |
| CV-08 | “Indian buyers always choose cheapest.” | Challenge generalization without stereotyping | CHALLENGE |
| CV-09 | Founder researching for three months | Offer useful test, not shame or forced task | ACT |
| CV-10 | Five students interviewed, four refuse to pay | Reflect without claiming statistical representativeness | REFLECT |
| CV-11 | “Stop asking questions. Tell me what to do.” | Direct answer and reduced questions | direct-intent override |
| CV-12 | “Not students; my customer is working women in Bengaluru.” | Immediate context correction and reviewable saved-memory update | correction override |

### 12.3 Conversation quality rubric

Score 0–2 in each of six dimensions: (1) intent understanding, (2) usefulness of intervention, (3) evidence/uncertainty, (4) naturalness and brevity, (5) respectful challenge, (6) memory/correction fidelity. Maximum 12. Record failure rationale and model/prompt version. A human-reviewed sample is mandatory; do not rely exclusively on model grading.

### 12.4 Release gates

**Must pass (blocking):**

1. All ownership/authentication and private export tests, including cross-tenant and guest AI denial.
2. All core correctness tests: idempotency, lost-update protection, review-before-memory-save, source validation, PDF approval/version parity.
3. No invented evidence IDs in curated evidence evaluation; no critical prompt-injection trust-boundary failure.
4. Provider failure, timeout, interrupted stream and limit scenarios leave honest recoverable state.
5. All P0 functional acceptance tests pass in a production-like staging environment.
6. Privacy/vendor data handling, retention/backups/deletion, operations response and numeric launch targets signed off (see §15).
7. AI conversation quality and correction targets measured, reviewed and approved; any deviation explicitly documented with risk acceptance rather than silently waived.

**Research/product validation (not automatic engineering pass/fail):** Conduct 12–15 discovery interviews, 6–8 observed prototypes and a small exploratory comparison against generic AI chat. Document results; sample sizes do not establish product-market fit.

---

## 13. Traceability: PRD → SRS → acceptance verification

The earlier PRD used `FR-01`…`FR-23`. Those IDs refer to **product requirements**, not the SRS's expanded `FR-001`…`FR-047`. The expanded mapping below is intentional; never assume matching numeric suffixes are equivalent.

| PRD baseline | Coverage in this SRS | Verification |
|---|---|---|
| PRD FR-01 Idea workspace | FR-003, FR-004, FR-005 | AT-002, 003, 004 |
| PRD FR-02 Conversation history | FR-007, FR-008 | AT-006, 007 |
| PRD FR-03 AI streaming/recovery | FR-009…FR-012 | AT-008…011 |
| PRD FR-04 Strategy selection | FR-016…FR-018 | AT-015…017 |
| PRD FR-05 Progressive depth | FR-013, FR-017 | AT-012, 016 |
| PRD FR-06 Memory review | FR-022…FR-024 | AT-021…023 |
| PRD FR-07 Corrections/history | FR-025…FR-028 | AT-024…027 |
| PRD FR-08 Assumption card | FR-020, FR-029 | AT-019, 028 |
| PRD FR-09 Experiment workflow | FR-030, FR-031 | AT-029, 030 |
| PRD FR-10 Learning reflection | FR-032, FR-033 | AT-031, 032 |
| PRD FR-11 Research/evidence | FR-034…FR-040 | AT-033…039 |
| PRD FR-12 Evidence/comparison cards | FR-019, FR-020, FR-036, FR-039 | AT-018, 019, 035, 038 |
| PRD FR-13 Reviewed Snapshot PDF | FR-041…FR-044 | AT-040…043 |
| PRD FR-14 Auth/authorization | FR-001, FR-002, FR-004 | AT-001, 003 |
| PRD FR-15 Data/privacy | FR-005, FR-006; NFR-001…003, 015 | AT-004, 005; PRIV-001 |
| PRD FR-16 AI telemetry | FR-045; NFR-012, 013, 018 | AT-044, OPS-001…003 |
| PRD FR-17…FR-21 (P1) | EX-001…EX-007 | Out of MVP; re-evaluate through change control |
| PRD FR-22…FR-23 (P2) | EX-008…EX-009 | Out of MVP |
| Updated DEC-001 name | Title, copy, UI-001…008 | Product copy review |
| Updated DEC-002 login-before-AI | FR-001, FR-002, INV-001 | AT-001 |
| Updated DEC-003 review-before-memory | FR-022…FR-028, INV-004/005 | AT-021…027 |
| Updated DEC-004 automatic research | FR-034, FR-035, FR-040 | AT-033, 034, 039 |
| Updated DEC-005 complete MVP | All FR-001…FR-047 | AT-001…046; release gate |
| Updated DEC-006 typed Hinglish | FR-013; NFR-019 | AT-012; UX-002 |

### 13.1 NFR trace / verification index

| Verification group | Requirements |
|---|---|
| SEC-001…005 | NFR-001, 002, 003, 017; FR-004, 038 |
| REL-001…002 | NFR-004, 005; FR-010…012, 028 |
| PERF-001…002 | NFR-006, 007 |
| AI-001…004 | NFR-008…011; FR-016…027, 034…039 |
| OPS-001…003 | NFR-012, 013, 018; FR-045…047 |
| UX-001…002 | NFR-014, 019; FR-013…015 |
| PRIV-001 | NFR-015; FR-005 |
| DOC-001 | NFR-016; FR-041…044 |

---

## 14. Critical consistency audit

| Area checked | Finding | Resolution / status |
|---|---|---|
| Product name | Earlier PRD called product “Thinking Partner” | **Resolved**: Founder's Lens is name; Thinking Partner is positioning (DEC-001) |
| Authentication | Earlier PRD left guest AI interaction open | **Resolved**: auth before all AI (DEC-002, FR-001) |
| Memory persistence | Automated suggestions could conflict with user control | **Resolved**: proposals remain pending until user review; current turn can use unconfirmed statements without treating them as saved fact |
| Automatic research | Prior PRD suggested approval/on-demand | **Resolved**: automatic relevant, bounded, transparent research (DEC-004); no per-search approval required |
| Research vs correctness | Auto-search does not imply verified results | **Resolved**: source validation, uncertainty, provider failure path, one concise finding |
| Full MVP | Earlier PRD allowed narrower evidence fallback | **Resolved**: full P0 scope retained; implementation may stage releases internally, not relabel missing P0 as shipped |
| English/Hinglish | Prior PRD was advisory | **Resolved**: typed mixed-language handling is required; full localization not implied |
| Structured stages | Risk of rigid wizard | **Resolved**: stages guide but do not block |
| Documents | Earlier PRD deferred Experiment Sheet PDF | **Retained**: only reviewed Idea Snapshot PDF required P0 |
| Provenance | User statement could be confused with market evidence | **Resolved**: trust classification enforced in data and UI |
| SRS/HLD separation | Next.js/DB were suggested, not user-facing behavior | **Retained**: those belong to HLD and ADRs; SRS remains technology-neutral |
| Source of truth | PRD is prior draft, SRS requested as enduring authority | **Resolved conditionally**: SRS becomes approved baseline on owner sign-off, with change control and blockers tracked |
| Provider data handling | Terms, retention and location not selected | **OPEN (beta blocker)**: OD-003 and OD-004 |
| Numeric SLOs | Prior p95 response target not measured | **OPEN for ratification**: NFR-006/007 are provisional |
| Long-term founder audience vs launch focus | Market too broad for tailored MVP | **Resolved as product boundary**: broad support, narrower initial optimization |
| Privacy/deletion | No concrete durations yet | **OPEN (beta blocker)**: OD-003 |

**Audit verdict:** The proposed SRS is internally coherent and traceable to the reviewed PRD plus six updated product-owner decisions. It is sufficient to begin HLD and LLD planning; it should **not** be marked “approved for public beta” until release-blocking open decisions are closed, privacy/provider contracts are reviewed, and measured targets are ratified.

---

## 15. Open decisions and assumptions register

**Unresolved does not mean implicitly approved.** For public beta, rows marked *Blocker* require an explicit decision, owner and date. For HLD, a reversible provisional design may be documented in an ADR without pretending the product decision is final.

| ID | Status / gate | Question | Current proposed direction / next action |
|---|---|---|---|
| OD-001 | OPEN / HLD | Which authentication/provider and supported sign-in methods? | HLD compares options; maintain strict login-before-AI invariant |
| OD-002 | OPEN / HLD | Which LLM and research providers, cost/failure characteristics, and sourcing policy? | Select after privacy, quality and pricing spike |
| OD-003 | OPEN / **Beta blocker** | Exact retention, data deletion latency, backups purge, and operational log retention? | Approve explicit policy, then test implementation |
| OD-004 | OPEN / **Beta blocker** | Provider content retention, subprocessors, training-use policy, disclosure and India-specific privacy review? | Review vendor terms and applicable law with appropriate expertise before accepting real users |
| OD-005 | OPEN / **Beta blocker** | AI/research account quotas, abuse thresholds and per-session spend caps? | Benchmark realistic Indian usage, approve transparent limits |
| OD-006 | OPEN / Beta sign-off | Final latency targets, concurrency profile and availability/incident response targets? | Load test and ratify NFR-006/007; define service objective |
| OD-007 | OPEN / Beta sign-off | Backup frequency, RPO/RTO, and restoration validation? | Approve recovery requirements after data criticality review |
| OD-008 | OPEN / UX validation | How are memory proposals grouped to avoid interruption? | Batch proposals at natural moments, no silent approval |
| OD-009 | OPEN / UX validation | What precisely counts as “relevant enough” to auto-research? | Evaluate using research/no-research fixtures and cost limits |
| OD-010 | OPEN / UX validation | Will one primary active experiment per idea improve focus? | Suggest one primary experiment; history may contain multiple |
| OD-011 | OPEN / analytics | Definition and integrity of “meaningful learning” session | Use user-confirmed outcome; audit gaming and false positives |
| OD-012 | OPEN / product validation | Does this help more than general AI chat? | Comparative moderated study; no differentiation claim before evidence |
| OD-013 | OPEN / architecture | Are long-running research/exports background jobs or synchronous? | Choose in HLD from platform constraints and reliability criteria |
| OD-014 | OPEN / risk policy | What is the exact content policy for regulated industry/business topics? | Write product-specific safeguards, cite official sources when needed |
| OD-015 | OPEN / beta readiness | Will users be minors; what age/consent requirements apply? | Define eligibility and verify applicable requirements before public beta |
| OD-016 | OPEN / beta readiness | What is the maximum per-object input length, file size (if any), and export history retention? | Define after usability/performance and privacy testing; no uploads in MVP |

### Assumptions to validate with real users

- **A-001:** Guided discussion gives clearer, more useful thinking than general AI chat.
- **A-002:** Founders find short, respectfully challenging responses acceptable and helpful.
- **A-003:** Review-before-save memory provides trust without excessive friction.
- **A-004:** Automatically triggered small, verified research is useful more often than distracting.
- **A-005:** Real-world experiment follow-up causes meaningful return usage.
- **A-006:** Typed Hinglish is sufficient for the launch wedge; full Hindi/voice may be needed later.
- **A-007:** A one- or two-page Idea Snapshot is more valuable than automatic long business reports.

**These are hypotheses, not confirmed market truths.** Pilot sample sizes (roughly 12–15 interviews and 6–8 task-based prototype sessions) are for discovering problems, not statistical proof of product-market fit.

---

## 16. Governance, change control, and document ownership

### 16.1 Sign-off workflow

1. Product owner reviews confirmed/derived/provisional requirements, especially §15.
2. Engineering lead reviews feasibility, trust boundaries, privacy implications, and testability.
3. QA/security reviewer (or explicit responsible reviewer in solo project) checks acceptance coverage and release blockers.
4. Owner approves a tagged SRS baseline (`v1.0.0-approved`); until then status remains **Proposed controlled baseline**.
5. HLD, LLD, API contracts, schema design, implementation and tests reference the approved SRS version.

### 16.2 Requirement change request (RCR) fields

Every change must document:

- `RCR-ID`, date, proposer and owner;
- user problem and supporting evidence;
- affected FR/NFR/DR/INV IDs and PRD references;
- new/modified/removed acceptance tests;
- privacy/security/data migrations and cost impact;
- MVP priority and explicit scope tradeoff;
- approval/rejection and decision rationale;
- version bump and migration/rollout considerations.

### 16.3 Versioning semantics

- **Patch** (`1.0.x`): typo/clarification with no behavior or test change.
- **Minor** (`1.x.0`): compatible requirements added or acceptance criteria expanded.
- **Major** (`x.0.0`): changed core scope, permissions, user-visible behavior, or conflicting obligation.

Keep a changelog and a list of ADRs linking consequential architecture choices to requirement IDs.

### 16.4 Change log

| Version | Date | Summary | State |
|---|---|---|---|
| 1.0.0 | 2026-11-12 | First complete SRS; incorporates six owner decisions; expanded traceable requirements and verification | Proposed; awaits owner approval and blocker decisions |

---

## 17. Suggested HLD handoff checklist

HLD must explicitly address these questions without rewriting product scope:

- [ ] System context and trust-boundary diagram, including identity, LLM and research providers.
- [ ] Data isolation model for account → idea → conversation/memory/evidence/experiment/export.
- [ ] Chat lifecycle sequence (auth, idempotency, generation, stream, persistence, retry, cancellation).
- [ ] Versioned domain model/ERD for memory proposals, revisions, evidence provenance, experiment learning and approved snapshots.
- [ ] Research relevance/limits, evidence validation and prompt-injection safeguards.
- [ ] Memory confirmation and concurrency semantics; correction in active vs durable context.
- [ ] PDF approval/version parity and secure delivery.
- [ ] Error taxonomy, provider degradation, rate limits and observability without private content.
- [ ] Staging evaluation harness for 12 fixtures, adversarial cases, security tests and performance baseline.
- [ ] ADRs on model/search providers, authentication, deployment, persistence and job execution.

---

## 18. Final review checklist / exit statement

| Check | Result |
|---|---|
| Six explicitly confirmed owner decisions incorporated | **PASS** |
| PRD P0 features included | **PASS** |
| P1/P2 exclusions identified | **PASS** |
| Functional requirements unique and individually verifiable | **PASS — 47 FRs** |
| Functional requirements mapped to acceptance tests | **PASS — 46 ATs, with AT-001 covering 2 related FRs** |
| Data classification, provenance and integrity rules | **PASS** |
| State transitions and failure cases specified | **PASS** |
| External interfaces separated from implementation choices | **PASS** |
| NFRs labeled confirmed/provisional/open | **PASS** |
| PRD → SRS → test traceability | **PASS** |
| Product assumptions distinguished from facts | **PASS** |
| Real-user proof of differentiation | **NOT YET VALIDATED** |
| Vendor privacy, retention, RPO/RTO, numeric production SLOs | **OPEN — prior to beta** |

**Specification conclusion:** This is a rigorous, review-ready engineering source-of-truth candidate for Founder's Lens. It intentionally avoids unearned claims of legal compliance, verified market demand, or measured performance. It is appropriate to begin system design now; it is **not** a substitute for product-owner approval, implementation tests, vendor/privacy review, or real-founder validation.
