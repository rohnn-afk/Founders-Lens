# Thinking Partner — Product Requirements Document

**Version:** 1.0.1 (review-ready draft; implementation guidance updated)  
**Status:** Proposed baseline; not yet user-validated or engineering-approved  
**Date:** 2026-11-15 (original product draft: 2026-11-11)  
**Owner:** Product / Engineering  
**Initial market:** India; expansion beyond India is not an MVP commitment  
**Primary platform:** Responsive web application  
**Selected implementation direction:** Next.js + TypeScript web; separate Node.js + Express 5 + strict TypeScript API; independent TypeScript workers (implementation guidance, not a user-facing requirement; see [HLD](HLD.md) and [ADR-013](ADR/013-express-typescript-api.md))

---

## 1. Executive summary

**Thinking Partner** is a conversation-first workspace for early-stage founders. It helps people clarify business ideas, question consequential assumptions, inspect grounded external information when useful, plan small real-world experiments, and record what they learn. The assistant is curious, supportive, and respectfully challenging; the user controls decisions and the direction of discussion.

**Positioning:** *The Thinking Partner, powered by ground reality and real-world experiments.*

**Value proposition:** A founder leaves a meaningful session with a clearer problem or assumption, a better-informed decision, or a feasible next learning action—not a generic validation score or an overwhelming automated business report.

**Differentiation hypothesis, not proven:** Compared with generic AI chat, the structured learning loop, editable provenance-aware idea memory, just-in-time evidence, and experiment reflection will generate more actionable learning and useful return visits.

**MVP thesis:** Deliver **one complete loop**: create an idea → discuss → identify one important assumption → optionally inspect evidence → save a feasible experiment → record findings → revise understanding → export a reviewed Idea Snapshot.

## 2. Problem, audience, and jobs to be done

### 2.1 Problem

Early-stage founders may have ambition, ideas, and access to general AI advice but struggle to distinguish assumptions from observations, ask focused questions, account for practical constraints, and carry learning across conversations. Generic plans can create false confidence while long questionnaires can discourage exploration.

These are hypotheses requiring user interviews; do not assume every Indian founder has the same background, constraints, or needs.

### 2.2 Audience and launch wedge

- **Long-term audience:** All early-stage founders, including idea explorers, founders with a concept, people doing customer discovery, and early executors.
- **Initial product optimization:** India-based, **pre-revenue founders who have a rough idea or are beginning customer discovery**. This narrower launch wedge resolves the tension between a broad audience and a coherent initial experience.
- **Secondary / limited support:** People with no idea yet and founders already running early pilots; handle core conversation but do not promise specialist planning capabilities.
- **Not targeted in MVP:** Funded teams requiring enterprise analytics, active companies needing operations management, regulated advisory clients, or users seeking investors/loans directly.

### 2.3 Jobs to be done

1. When I have a vague business idea, help me identify who has the problem and what I am assuming.
2. When I'm confident about demand, help me separate enthusiasm from actual customer evidence.
3. When local market realities matter, give me one relevant, sourced finding and its limitations.
4. When I have limited money or time, help me choose an achievable, low-cost way to learn.
5. When I return with observations, remember my prior hypothesis and help me update it.
6. When I want to share my thinking, create a short, editable, evidence-labeled document I can review and export.

## 3. Product principles and explicit boundaries

1. **Conversation first:** one useful point at a time, not an interrogative form.
2. **Founder agency:** guide without claiming authority over the founder's decision.
3. **Progressive depth:** concise default answers; expand on request.
4. **Adaptive visuals:** predefined cards only when they materially help.
5. **Evidence integrity:** label user reports, unverified hypotheses, AI interpretations, and independently sourced information distinctly.
6. **Ground reality:** ask about geography, purchasing habits, alternatives, distribution, budget, and time only when relevant; avoid cultural stereotypes.
7. **Selective memory:** save important information with provenance and correction controls, not indiscriminate chat summaries.
8. **Learning over engagement:** offline progress is valuable even if it reduces conversation time.
9. **Private by default:** protect idea confidentiality and make data controls understandable.
10. **No false precision:** no startup success probability, definitive market-validation verdict, or invented local statistics.

### Decisions already made

| Dimension | Decision |
|---|---|
| Brand / positioning | Thinking Partner; ground reality and real-world experiments |
| Broad audience | All early-stage founders |
| Launch wedge (recommendation) | Pre-revenue founders with a rough concept / early discovery |
| Journey | Structured, adaptive, non-blocking stages |
| Personality | Curious, supportive, respectfully challenging |
| Memory | Editable idea memory and learning history |
| Research | Small, verified insights where relevant |
| Outcome | Clearer assumptions and real-world learning |
| Visuals | Adaptive, predefined, embedded in conversation |
| Document workflow | Reviewed and editable before export |
| Depth | Short first, expand on demand |

## 4. Personas (provisional; validate with interviews)

| Persona | Situation and goal | Constraints | Needs / risk |
|---|---|---|---|
| P1: Working professional | Wants to test a side business | Limited time and risk budget | Feasible experiments; avoid unrealistic quit-your-job advice |
| P2: Student founder | Has a promising app/service idea | Limited customer access or spending power | Question willingness to pay without dismissing ambition |
| P3: Local business successor | Wants to modernize a family shop/service | Existing offline processes, relationships | Explore actual order channels and customer trust before recommending software |
| P4: First-time local-services founder | Considering food, laundry, tutoring, etc. | Geography, regulation, operations, price | Specific local questions, reliable evidence, low-cost testing |
| P5: Returning founder | Has feedback from early customers | Contradictory anecdotes and changing assumptions | Reflection, revision history, decision continuity |

**Anti-persona:** User looking for guaranteed investment, legal, tax, or business-success predictions; provide general educational support and boundaries instead.

## 5. End-to-end user journeys

### J1. New founder: rough idea to a test

1. User opens landing/start page and describes an idea in natural language; no long onboarding form.
2. App creates or selects a private idea workspace.
3. Assistant asks at most one primary question per response, progressively clarifying customer and problem.
4. Assistant identifies one meaningful hypothesis as a **pending assumption proposal**.
5. User confirms/edits/dismisses it; no silent promotion to verified fact.
6. Assistant optionally offers targeted external evidence; when research is run, the result has provenance and scope.
7. Assistant suggests a feasible experiment when useful and welcome.
8. User accepts/edits/saves it, or continues brainstorming.

**Success:** The user can articulate a key unknown and optionally save an achievable next step. No mandatory experiment.

### J2. Returning founder: observations to learning

1. User returns to the same idea; app recalls relevant confirmed context.
2. User shares customer observations or experiment results.
3. Assistant compares findings to the prior hypothesis without overgeneralizing.
4. User can save a learning and revise their assumption; revisions stay inspectable.
5. App displays the updated idea summary and next question/action.

**Success:** New learning is accurately linked to the earlier assumption, and the founder retains agency.

### J3. Research inside conversation

1. User requests data or assistant offers a narrow, relevant search.
2. System clarifies critical missing scope only if needed (e.g., city, customer type).
3. Trusted research service retrieves candidate sources, captures timestamps/scope, and evaluates suitability.
4. One concise finding appears with source and limitations; uncertainty is explicit if quality is inadequate.
5. User can inspect source information or return to discussion.

**Success:** No fabricated statistics or unsupported evidence cards.

### J4. Reviewed Idea Snapshot PDF

1. User chooses **Create Idea Snapshot**.
2. Document is populated from structured, authorized idea state; unknowns remain marked unknown.
3. User reviews and edits a preview, then confirms export.
4. Server exports exactly the approved document version, with provenance and generated date.

**Success:** Download content matches the reviewed preview; no LLM regeneration at export time.

### J5. User corrects prior context

1. User says an assumption/customer segment is wrong.
2. Assistant immediately stops using the incorrect value in the current conversation.
3. App identifies any conflicting saved memory and offers correction review.
4. After successful save, future conversations use the revised version and retain appropriate audit metadata.

**Success:** No claim of persistent update until the database confirms it; no repeated reliance on rejected memory.

## 6. Experience and screen specification

### Screen A — Welcome / Start

- One prominent free-text prompt: “What are you thinking about building?”
- Optional starter prompts for a rough idea, no idea yet, or returning to an idea.
- Authentication timing can be designed to minimize friction, but private saved work requires identity before persistence.
- No business-plan questionnaire.

### Screen B — Thinking Workspace (primary)

- Conversation thread with streaming states, retry/stop, readable source links and clear failure feedback.
- Multiline composer, keyboard support, pending/sent/failed message indicators.
- Small current-journey indicator (Explore → Question → Discover → Experiment → Reflect), non-blocking and revisitable.
- Up to **two contextual actions** displayed when relevant, e.g. Challenge this, Find evidence, Compare, Small test, Explain more.
- **At most one primary card per assistant turn**. Predefined card types: Assumption, Evidence, Comparison, Experiment.
- Optional side panel on desktop: My Idea; on mobile a dedicated panel or route.
- Default conversational answers concise (roughly 40–90 words as guidance, not a hard limit); one main question when a question helps. Not every reply must end in a question.

### Screen C — My Idea

- Editable idea overview: customer, problem, current alternatives, hypotheses, evidence, open questions and decisions.
- Every claim shows type (user statement, hypothesis, verified evidence, AI suggestion), origin and status.
- Review, edit, dismiss and delete controls; show important revisions.

### Screen D — My Learning

- Current experiment, completed experiments, observations, and revisions of understanding.
- An experiment records hypothesis, action, constraint/cost limit if relevant, observation criterion, and result.
- No task-management bloat or mandatory streaks.

### Screen E — Document Preview

- Reviewed, editable Idea Snapshot; unknown claims clearly labeled.
- Export PDF from immutable approved snapshot with date and source references.
- Experiment Sheet PDF is **post-MVP** unless pilot demand and engineering capacity justify it.

### Screen F — Account / Privacy

- Settings, language preference, data export/delete controls, privacy explanation.
- Founders' idea content is private by default; no public idea gallery in MVP.

## 7. Conversation engine behavior contract

**Six strategies:** `EXPLORE`, `CHALLENGE`, `INFORM`, `COMPARE`, `ACT`, `REFLECT`.

**Priority:** Safety and explicit user controls → immediate user intent → relevant context → useful intervention → journey progression.

**Core behaviors:**

- Clarify unclear customer/problem rather than immediately generate plans.
- Challenge consequential unsupported beliefs respectfully; don't challenge for its own sake.
- Answer direct requests directly; stop excessive questioning when asked.
- Offer research selectively; verified information uses source-backed evidence records, not model-invented citations.
- Propose experiments when relevant, feasible, and not against the user's preference to keep exploring.
- Reflect on small customer samples without inferring population-level certainty.
- Handle English, Hinglish, and mixed input conversationally; **voice transcription and full localization are out of MVP**.
- Support idea switching with idea-scoped state; avoid cross-idea memory leakage.
- User-facing content must not diagnose founder psychology or label the user permanently based on inferred personality.

### Structured assistant response contract (logical shape)

- `version`: `1.0`
- `strategy`: one of six strategies
- `message`: concise reply
- `question`: optional, at most one primary question
- `card`: zero or one validated card (`assumption`, `evidence`, `comparison`, `experiment`)
- `memoryProposals`: zero or more reviewable candidates with type and message provenance
- `needsResearch`: advisory only; backend controls research execution

**Trust boundary:** Model output is untrusted. Backend validates types, lengths, identity, evidence references, and allowed actions. The model cannot directly mutate confirmed memory, authorize evidence, or perform external business actions.

## 8. Prioritized functional requirements

Priority legend: **P0** = essential MVP; **P1** = next iteration; **P2** = exploratory/future.

| ID | Priority | Requirement | Acceptance criteria |
|---|---|---|---|
| FR-01 | P0 | Create/read/update/delete private idea workspace | Authorized user can manage only their own ideas; deletion follows policy |
| FR-02 | P0 | Conversation persistence and resumability | Sent messages survive refresh; reopening shows correct idea-scoped history |
| FR-03 | P0 | Stream AI responses with recovery states | Client displays progressive response; failure or disconnect produces recoverable state without duplicate messages |
| FR-04 | P0 | Adaptive strategy selection | Curated scenarios receive relevant strategy; explicit user direction overrides stage progression |
| FR-05 | P0 | Progressive answer depth | Concise default; expand/current-topic detail on demand; no repetitive forced questions |
| FR-06 | P0 | Reviewable idea-memory proposals | User can confirm/edit/dismiss; hypothesis cannot be silently saved as fact |
| FR-07 | P0 | Correction and revision history | Corrections take effect in current context immediately; persistent edit only after successful save |
| FR-08 | P0 | Assumption card | A meaningful assumption can be reviewed, edited, saved or dismissed |
| FR-09 | P0 | Experiment recommendation and tracking | User can create/edit/dismiss a realistic test; record result and link it to assumption |
| FR-10 | P0 | Learning reflection | Earlier hypothesis and reported outcome are linked without overclaiming findings |
| FR-11 | P0 | Narrow on-demand evidence retrieval | Verified findings have inspectable source, date, scope and caveat; unavailable results are explicitly uncertain |
| FR-12 | P0 | Evidence and comparison cards | Only typed, server-validated cards; max one primary card per assistant turn |
| FR-13 | P0 | Reviewed Idea Snapshot PDF | Document generated from idea state; preview is editable; exported version equals approved version |
| FR-14 | P0 | Authentication and authorization | Every private read/write/export checks identity and idea ownership |
| FR-15 | P0 | Data/privacy controls | Users can see and delete their ideas; data export scope and deletion semantics documented |
| FR-16 | P0 | AI quality and cost telemetry | Capture non-sensitive latency, tool error and token-cost metrics; evaluate curated scenarios |
| FR-17 | P1 | Experiment Sheet export | Generate printable customer interview/test sheet from reviewed experiment |
| FR-18 | P1 | Idea evolution timeline/assumption map | Show meaningful revisions; users can inspect origin and change history |
| FR-19 | P1 | File/screenshot intake | Safely analyze user-provided interview notes/competitor screenshots |
| FR-20 | P1 | Voice notes and richer Hinglish support | Correctable transcription and accessible input experience |
| FR-21 | P1 | Lightweight unit economics helper | Explicit input assumptions; transparent arithmetic; no fabricated forecasts |
| FR-22 | P2 | Co-founder collaboration | Idea-scoped invitations and permissions |
| FR-23 | P2 | Comprehensive plan/deck generation | Only if user demand and evidence quality justify it |

### Critical scope clarification

The **P0 evidence feature** is intentionally limited to small, targeted lookups, not continuous autonomous web monitoring. If research integration threatens core stability, a tightly scoped curated/restricted source implementation can precede broad web retrieval; unverified results must not masquerade as verified.

## 9. Non-functional requirements (initial engineering targets)

| ID | Category | Requirement / target | Verification |
|---|---|---|---|
| NFR-01 | Security | Deny cross-user / cross-idea access for every endpoint and export | Authorization integration tests |
| NFR-02 | Data integrity | Idempotent message submissions and safe update conflicts | Duplicate-submit and concurrent-edit tests |
| NFR-03 | Privacy | Private-by-default idea content; minimal logging; documented export/deletion policy | Security review and manual audit |
| NFR-04 | Availability | Recover gracefully from AI/research provider unavailability | Fault-injection tests |
| NFR-05 | Performance | Aspirational p95 initial streamed response < 5 s for non-research paths in a defined test environment | Load test; revise after baseline |
| NFR-06 | Content integrity | No fabricated source identifiers in evaluated outputs | Evidence validator + evaluation suite |
| NFR-07 | Quality | At least 90% of curated test conversations score ≥ 10/12 on rubric, subject to human review | Versioned evaluation set |
| NFR-08 | Correction accuracy | At least 95% of curated explicit-correction cases reflected in next reply | Automated and human review |
| NFR-09 | Accessibility | Keyboard operability, clear focus and contrast, responsive mobile layouts | Manual WCAG-oriented audit |
| NFR-10 | Cost | Set configurable per-user LLM/research limits and inspect request cost | Cost dashboards/alerts |
| NFR-11 | Observability | Structured errors, request/correlation IDs, latency, provider failure rates; sensitive data minimized | Staging traces and dashboards |
| NFR-12 | Reliability | PDF output deterministic from approved snapshot; no silent failed saves | Integration tests |

**Note:** Targets are planning hypotheses, not existing performance or market benchmarks. Define workload, dataset, hosting and latency measurement before treating them as release gates.

## 10. Success metrics and instrumentation

### North-star hypothesis: Meaningful Learning Rate (MLR)

**Definition, pilot version:** `eligible completed sessions with at least one user-confirmed meaningful learning event / eligible completed sessions`. A learning event may be a clarified testable assumption, a documented evidence-based revision, or reflection on an experiment result. An AI-generated summary alone does not count.

**Caveat:** This metric is susceptible to prompt-induced confirmations; validate with user interviews and review samples rather than optimizing only for clicks.

### Supporting measures

| Measure | Definition / purpose |
|---|---|
| First-session clarity change | Brief before/after assessment of problem, customer and important unknown |
| Experiment commitment rate | Proportion of eligible sessions with a user-accepted, feasible experiment |
| Experiment completion rate | Percentage of accepted experiments later reported as attempted/completed |
| Meaningful return rate | Returning users who contribute new evidence, reflection or a substantial question |
| Evidence correction rate | Frequency of sourced claims later flagged as inaccurate/out-of-scope |
| Memory correction rate | How often a saved item needs user correction; monitor impact, not just count |
| Trust / utility | User-rated usefulness, ability to disagree, and willingness to compare favorably with general AI chat |
| AI cost per meaningful session | Token/research spending divided by completed meaningful sessions |

### Initial research plan

- Interview **12–15** diverse prospective Indian founders across launch personas; investigate current behavior, not hypothetical preferences.
- Conduct **6–8** observed prototype sessions with the core journey.
- Compare a guided prototype against general AI chat for similar tasks using a small, carefully defined exploratory sample.
- Invite repeat sessions to observe whether people return with genuine field learning.

**No numeric product-market-fit claim from these samples.** Targets such as 60% actionable next steps are exploratory test hypotheses only.

## 11. Failure scenarios and acceptance tests

### Functional / deterministic

1. Invalid model JSON: reject; safely recover without fabricated structured objects.
2. Unknown UI card type: never render it.
3. Model-provided evidence reference missing from trusted store: block evidence card.
4. Duplicate send or network retry: one logical user message for same idempotency key.
5. Stream disconnect: clear terminal/recoverable state; no phantom completed response.
6. Database failure during memory update: no premature “saved” confirmation.
7. Concurrent memory edits: detect conflict or deterministically merge with user awareness.
8. Idea switch: no cross-idea memory in prompts, results or exports.
9. Cross-user ID access: denied for chat, memory, experiments, and files.
10. Research outage: uncertainty and retry option; no invented figures.
11. PDF after editing preview: output matches approved snapshot/version.
12. Idea deletion: inaccessible afterward; retention/deletion policy followed.

### Conversation evaluation scenarios (12 initial fixtures)

1. Vague founder: “Bhai business start karna hai.” → explore problems, no indiscriminate idea list.
2. Overconfident student app founder → challenge universal willingness-to-pay claim.
3. Working professional with ₹20,000 and weekends only → feasible, bounded test.
4. Family hardware shop going online → ask about real ordering behavior first.
5. Jaipur cloud kitchen demand → ask for relevant geographic/customer scope before market claims.
6. Gym CRM SaaS versus services → tradeoff comparison without invented scoring.
7. “No competitors in India” → probe substitutes; verify if research requested.
8. “Indians only buy cheap products” → challenge stereotype, clarify segment.
9. Founder who has researched for months → optionally suggest small test without moralizing.
10. Five interviews, four negative → reflect without inferring population statistics.
11. “Stop asking questions” → answer directly and change interaction style.
12. Wrong saved target customer → respect correction immediately and offer memory revision.

**Rubric (0–2 each; total 12):** intent match; useful intervention; groundedness; conversational naturalness; respectful challenge; memory/correction fidelity. Human + automated review, with security and fabricated-citation failures blocking release regardless of average rubric score.

### Additional adversarial cases before public beta

Prompt injection in retrieved webpage; forged provider citation; malicious uploaded instructions (once uploads launch); account boundary probes; false source date; user changes idea mid-stream; cancellation/retry; unsafe regulated advice; sensitive data in error logs.

## 12. Analytics, privacy and safety constraints

- No public sharing or training-on-private-ideas assumption by default. Any processing/data retention by LLM providers must be disclosed and contractually reviewed.
- No hidden founder “psychology” scoring, diagnosis or behavioral profiling.
- No automatic spending, messaging customers, filing business documents, or external business actions.
- For food, legal, tax, finance, or regulated activities: offer general educational information, contextual uncertainty, and appropriate professional/regulator verification; do not guarantee compliance.
- Treat external documents, search results and user uploads as untrusted input. Retrieved text cannot override system policies or permissions.
- Do not invent market size, price data, customer testimonials, or success probabilities.
- Distinguish first-party research, reliable third-party sources, anecdotal customer observations, and user beliefs.
- Make it possible to correct, export and delete stored idea content; specify backup retention before launch.
- Analytics should minimize personal business-content collection; prefer aggregated events and operational metadata.

## 13. Dependencies and MVP engineering guidance (non-binding)

- Next.js + TypeScript web, independently deployed Node.js + Express 5 + strict TypeScript API, and separate BullMQ + Redis TypeScript workers; modular domain/service boundaries within the shared codebase. The current HLD governs implementation choices.
- PostgreSQL as initial system of record; external LLM and optional search provider through server-only adapters.
- Trusted API boundary for model output parsing and evidence-card reference validation.
- Background jobs only where needed for long-running work/export; do not prematurely add microservices, Kafka, or a vector database.
- Shared versioned Zod schemas for runtime request/response and model-output validation, with inferred TypeScript types; explicit Express validation middleware and centralized user/idea ownership checks. TypeScript types alone do not validate external input.
- Design system supports a finite set of typed cards; no model-generated arbitrary HTML/JS.
- Version assistant prompts, model configuration, evaluations and significant architecture decisions.

## 14. Delivery phases and exit criteria

| Phase | Scope | Exit criterion |
|---|---|---|
| 0. Discovery | Interviews, comparison against general AI chat, 12 scenarios | Specific problems and useful interaction patterns supported by qualitative evidence |
| 1. Design | User flows, screen wireframes, engine contract, HLD/LLD | Documented contracts and reviewed failure cases |
| 2. Thin vertical slice | Auth, idea creation, streaming chat, persistence, resume | End-to-end message flow passes duplicate/recovery/ownership tests |
| 3. Thinking memory | Strategy rules, memory proposals, correction/revision | Curated dialogue tests and memory integrity tests pass |
| 4. Ground & act | Targeted research, evidence cards, assumption and experiment loop | Evidence validity and reflection workflow validated |
| 5. Export and hardening | Reviewed Snapshot PDF, observability, cost/security tests | Approved-preview equality; no critical regressions |
| 6. Pilot | Small real-user beta | Document actual qualitative learning, usefulness and outstanding failures |

This is iterative, not waterfall. Revisit flows/contracts after observed user sessions.

## 15. Critical review (devil's-advocate audit)

| Finding | Severity | Resolution |
|---|---|---|
| “All early-stage founders” is too broad for a focused first release | High | Distinguish long-term audience from pre-revenue launch wedge |
| Structured journey may feel like rigid homework | High | Journey is internal guidance; users can jump, skip, or stop |
| Memory plus chat can look indistinguishable from general-purpose AI | High | Validate learning loop, decision provenance and return usefulness versus baseline |
| Auto-generated evidence risks fabricated certainty | High | Trusted retrieval records, explicit scope/date, no fake evidence cards |
| MVP with chat, research, memory, experiments, exports is ambitious | High | Build vertical slices; cap research, only one PDF template in MVP |
| Excessive questions could frustrate founders | Medium | Direct-answer override; one question default, sometimes none |
| Review-before-save could become interruptive | Medium | Batch memory suggestions at natural points; confirm meaningful items |
| Claims about Indian psychology can create stereotypes | High | Ask about user-specific constraints; do not infer from nationality |
| PDFs could turn into a report factory | Medium | One short editable Idea Snapshot only; prohibit unsupported claims |
| “Meaningful Learning Rate” could be gamed | Medium | Require user confirmation and conduct qualitative audit |
| Performance promises can be unrealistic with research or model latency | Medium | Separate non-research target from research latency; baseline first |
| Data deletion and LLM-provider retention not yet defined | High | Resolve vendor, retention, and backup policy before real-user beta |

**Review verdict:** Ready as an initial product requirements baseline for UX prototyping and technical design, **not** evidence of product-market fit or final approval to ship. Strongest unresolved risks are actual willingness to use over generic chat, trust in sourced evidence, and scope feasibility.

## 16. Open decisions and owners

| ID | Decision | Proposed default | Resolve by |
|---|---|---|---|
| OD-01 | Must users sign in before first message? | Permit a limited guest first interaction; require login to persist | UX prototype / security design |
| OD-02 | What is the exact memory confirmation cadence? | Batch meaningful proposals at natural milestones; correction immediate in conversation | Prototype usability test |
| OD-03 | Should research run proactively or require approval? | Assistant may suggest research; user can initiate or approve costly lookups | Prototype / cost study |
| OD-04 | Is P0 live evidence too broad? | Limit to narrow, verifiable lookups; defer broad market intelligence | Technical spike |
| OD-05 | Which initial research providers/sources? | Choose after source quality, price and licensing review | HLD/architecture |
| OD-06 | Initial language promise? | English and typed Hinglish; no voice and no language-quality guarantee | Pilot testing |
| OD-07 | Single active experiment per idea? | Show one primary experiment; preserve archived/completed history | UX validation |
| OD-08 | Document review model? | Editable structured fields + immutable export snapshot | LLD |
| OD-09 | Account retention, deletion and backups? | Document and verify before beta; no unbounded private-content logs | Security review |
| OD-10 | What constitutes a “meaningful learning” event? | User-confirmed evidence-linked improvement; test measurement validity | Product analytics design |
| OD-11 | Free usage and abuse limits? | Cost-controlled pilot with transparent usage limits | Cost modeling |
| OD-12 | Do real founders prefer this over standard AI chat? | Unknown; test directly before broad feature build | Discovery gate |

## 17. Next artifacts

1. **User flow and low-fidelity screen wireframes** — explicitly test a natural, non-interrogative experience.
2. **SRS/NFR refinement** — confirm measurable environments and security/deletion expectations.
3. **HLD and C4 diagrams** — identify component and trust boundaries.
4. **LLD:** ERD, API contracts, message/memory/experiment state machines, stream sequence diagrams, PDF snapshot semantics.
5. **AI evaluation fixtures:** versioned scenario dataset, rubric and regression harness.
6. **ADRs:** modular monolith, data store, research provider, memory review policy, streaming failure policy.

---

**Change control:** Every new feature must state user problem, measured/observed justification, priority, acceptance criteria, data impact, risk, and which existing scope it displaces. No feature is added to P0 simply because it is technically interesting.

**Implementation guidance update — 2026-11-15:** Express 5 + strict TypeScript replaces the earlier Fastify backend selection; see [ADR-013](ADR/013-express-typescript-api.md). This clarification changes implementation guidance only. The SRS continues to govern MVP behavior and supersedes conflicting proposals in this original product draft.
