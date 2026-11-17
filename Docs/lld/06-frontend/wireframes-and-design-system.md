# Founder's Lens — LLD Phase 4B: Wireframes, Design System & Interaction Patterns

**Document ID:** FL-LLD-FE-4B  
**Version:** 0.5 — approved final mapping design
**Status:** Approved — Documentation Only under FE4D-A08, revision `FL-P4-0.5-approved`. Exact tokens, measured accessibility, migrations and runtime remain provisional/unvalidated. See the [approval manifest](approved-revision-0.5.json) and [4D §19](frontend-integration-review.md#19-formal-phase-4-documentation-sign-off). Historical preparation reviews do not override this package status.
**Scope:** Low-fidelity responsive screen wireframes, information hierarchy, design tokens, reusable UI components, state/error patterns, accessibility rules and visual acceptance criteria. **Documentation only; no application code, polished mockups, Figma asset or live UI.**

## 1. Scope, sources and authority

This specification elaborates canonical **Phase 4A v0.2** (`frontend-fundamentals-journeys-architecture.md`) and must comply with the manifest-verified approved Phase 2D (`FL-P2D-1.0-approved`) and Phase 3 (`FL-P3-0.3-approved`) design decisions. Phase 4A itself is a **review draft**, so Phase 4B decisions are proposals, not inherited approvals. Phase 4B avoids altering authenticated API, database, state machines, memory authority or response semantics.

**Source boundaries:** Phase 4A §3–5 (conversation-first journeys, surfaces/routes), §7–10 (backend ownership, streaming, review flows), §11–12 (accessibility/security), §14–17 (acceptance, gaps, decisions). Phase 3's approved structured response allows **exactly one primary strategy, zero or one assistant card, and at most two prominent contextual actions**; its default legacy API shape remains unchanged unless explicitly requesting structured transcript representation 2. Server states and actual OpenAPI have now been compared in 4C/4D; runtime validation remains pending. The repository is now inspected; source-exact reconciliation is recorded in 4D. Earlier absence caveats are historical.

### 1.1 Human-language glossary

| Term | Short explanation | Example |
|---|---|---|
| Wireframe | A simplified sketch showing where interface elements go | Chat layout before colors/polish |
| Design token | A reusable value for color, spacing or type | The same border radius on cards |
| Component | A reusable interface building block | A memory-review card |
| Responsive layout | An interface adapting to available screen width | Sidebar becomes a mobile menu |
| Breakpoint | A width where layout behavior changes | Two columns become one |
| Visual hierarchy | Making the most important content easiest to notice | Conversation comes before metadata |
| Empty state | A useful screen shown when no data exists | “Start your first idea” |
| Live region | An accessibility mechanism for announcing updates | “AI response completed” |
| Focus management | Ensuring keyboard users remain oriented | Return focus after closing a dialog |
| Design variant | A predefined component form | A caution-state evidence card |
| Skeleton | A placeholder while content loads | Reserved space for idea list |

### 1.2 Experience principles (mandatory from prior contracts)

1. **Conversation leads.** Authentication precedes AI, but no mandatory business-plan questionnaire follows authentication.
2. **Only real statuses.** “Sending,” “Accepted,” “Running,” “Stopping,” “Completed,” “Failed,” and “Cancelled” reflect actual client/server facts; a stream interruption is not a cancellation.
3. **Founder decides.** Memory proposals, saved experiments, approvals, deletion and downloads require explicit founder actions and server confirmation.
4. **Evidence is not certainty.** Founder beliefs, research findings, user observations, interpretations and model suggestions are visibly distinct.
5. **Quiet interface.** One optional card and up to two prominent actions per AI turn; avoid persistent gamification, forced stage checklists, or artificial confidence scores.
6. **Security and privacy are server-owned.** UI cannot grant ownership, skip If-Match, restore removed memory or mutate approved snapshots.
7. **Accessible and mobile usable.** Keyboard, focus, high zoom, screen readers, reduced motion and mixed English/Hinglish input are first-class.

## 2. Information hierarchy and layout decision

### 2.1 Recommended high-level app shell

**Desktop recommendation (≥1024 CSS px, subject to usability tests):** slim global sidebar with idea/conversation navigation; central, reading-width conversation; optional **on-demand** right detail drawer, never always-on dense dashboard. Chat composer stays reachable near viewport bottom, accounting for keyboard and safe areas. On smaller widths hide persistent right context pane.

**Tablet recommendation (768–1023 px):** collapsible navigation overlay, single primary content column, right detail shown as overlay/drawer.

**Phone recommendation (<768 px):** compact title/idea switcher, accessible menu or bottom navigation for **Think / My Idea / My Learning**; Snapshots and Settings clearly discoverable from More/menu. Composer remains reachable above the on-screen keyboard. Use screen width and user settings, not device/user-agent labels, as implementation breakpoints.

These breakpoints are **provisional design tokens**, not verified framework behavior. Use content-based resizing and test 320/360/390/768/1024/1440 CSS px, browser zoom 200%/400%, landscape and long text before approval.

### 2.2 Desktop thinking workspace — low-fidelity wireframe

```text
┌──────────────────────┬───────────────────────────────────────────────────┐
│ FOUNDER'S LENS       │ [Idea: Tiffin service ▾]       [Account / Help]   │
│                      ├───────────────────────────────────────────────────┤
│ + New idea           │ [Think] [My Idea] [My Learning] [Snapshots]       │
│ Idea switcher        ├───────────────────────────────────────────────────┤
│                      │  Conversation: Finding first paying customers    │
│ Conversations        │                                                   │
│  • Current           │  YOU                                              │
│  • Older...          │  “I think Delhi students will pay ₹3,000.”       │
│                      │                                                   │
│ [Conversation list]        │  FOUNDERS' LENS  • Challenge                      │
│                      │  “That's a useful hypothesis. How would you…”    │
│                      │  ┌─────────────────────────────────────────────┐  │
│                      │  │ Assumption to test                         │  │
│                      │  │ Delhi students may pay ₹3,000/month        │  │
│                      │  │ Not validated                              │  │
│                      │  └─────────────────────────────────────────────┘  │
│                      │  [Plan a small test] [Review assumption]          │
│                      │                                                   │
│ [Privacy/settings]   │  [Sources / details — expandable, if present]    │
│                      ├───────────────────────────────────────────────────┤
│                      │ [Ask or continue thinking…                  ]    │
│                      │ [Research setting] [Send] [Stop if running]      │
└──────────────────────┴───────────────────────────────────────────────────┘
```

**Interaction specification:** Primary reading width suggested 680–760 px inside content column. The assistant is identified clearly without relying solely on a colored avatar. Strategy is optionally displayed as a subdued label or accessible description, **not** an evaluative score or an intimidating workflow step. The question may be within prose; never create a second mandatory question from a metadata field. Source expander appears only with real authorized source references. Placeholder actions never commit business changes automatically.

### 2.3 Mobile thinking workspace

```text
┌──────────────────────────────────┐
│ [☰] Tiffin service ▾  [Account] │
├──────────────────────────────────┤
│ Conversation title             ⋯ │
│                                  │
│ YOU                              │
│ “Students will pay ₹3,000.”      │
│                                  │
│ FOUNDERS' LENS                   │
│ “What price have you tested?”    │
│ ┌──────────────────────────────┐ │
│ │ Assumption to test           │ │
│ │ Not validated               │ │
│ └──────────────────────────────┘ │
│ [Review assumption]              │
│ [Plan a small test]              │
│                                  │
├──────────────────────────────────┤
│ [Message…                    ]   │
│ [Research off]          [Send]    │
├──────────────────────────────────┤
│ [Think] [My Idea] [Learning] [⋯] │
└──────────────────────────────────┘
```

**Mobile details:** Prominent actions stack when horizontal width is constrained; still at most two. Long card content wraps and scrolls with the page rather than horizontally. Avoid a second fixed element covering the composer. If software keyboard is open, navigation may adapt, but critical Send/Stop must remain usable; test screen reader and visual viewport. “More” includes Snapshots and Settings, with explicit labels in assistive text.

## 3. Founder journey wireframes and key states

### 3.1 Public landing → authentication → first idea

```text
PUBLIC LANDING (non-AI)          AUTHENTICATED EMPTY WORKSPACE
┌─────────────────────────┐     ┌───────────────────────────────────┐
│ Founder's Lens          │     │ Welcome. What are you thinking?  │
│ Think clearly about     │     │                                   │
│ your next idea.         │     │ [Describe an idea in your words]  │
│ [Get started / Sign in] │ --> │ [Create idea and continue]        │
│ [Read how it works]     │     │ No questionnaire required.        │
└─────────────────────────┘     └───────────────────────────────────┘
```

No pre-login AI call. If the product permits a public typing preview, label it **unsent** and do not promise it survives sign-in. First post-auth content create uses existing authorized operations; do not invent a one-step backend endpoint that creates an idea and sends a chat unless 4C proves it exists.

### 3.2 Idea chooser / returning founder

```text
My ideas
[+ New idea]
┌──────────────────────┐  ┌─────────────────────┐
│ Tiffin service       │  │ Neighborhood repair │
│ Last conversation…   │  │ Last conversation…  │
│ [Continue thinking]  │  │ [Continue thinking] │
└──────────────────────┘  └─────────────────────┘
Empty: “Your first idea starts with a conversation.” [Create idea]
```

Cards show only owned idea title and a non-sensitive summary where permitted. No fabricated “progress percentage,” quality grade or opportunity score. Archive/deleting status reflects actual state; deleted idea is not clickable. A last-conversation label requires a separate authorized list read; Idea DTO does not expose a lastConversation field. No global server-search, quality score or progress endpoint is inferred from a mockup.

### 3.3 “My Idea” evidence and memory

```text
My Idea — Tiffin service
[Assumptions] [Memory] [Evidence]

Assumption                                         [Review / edit]
“Students will pay ₹3,000/month”
Class: Founder hypothesis  •  Evidence: Not yet established
Linked sources: [only when relationship data is available]

Memory proposal                                   [Pending review]
“Target customer: working professionals in Bengaluru”
Source: [show only if authorized source metadata is returned]
[Edit & accept] [Accept] [Dismiss]

Confirmed memory
“Target customer: college students in Delhi”
[Correct] [Remove] [Revision history]
```

**Key differentiation:** “Pending review” is never visually equivalent to “Confirmed.” Corrections in live chat are honored without automatically changing saved memory. Every server mutation waits for success; 412 version conflict shows **Refresh and compare**. Removed memory is not recycled into other UI summaries or quick prompts.

### 3.4 “My Learning” assumptions, experiments and outcomes

```text
My Learning
[Experiments] [Observations & learnings]

Experiment: Offer 10 trial lunches
Hypothesis: 3 of 10 invitees will pay
Success signal: 3 paid orders
Status: [backend state, not inferred]
[View experiment] [Record observation]

Observation: [founder-reported result;LearningV2.observation,nullable when not recorded]
Interpretation: Interest has not demonstrated paid demand.
[Review linked learning]
```

Use distinct title, hypothesis, observation and interpretation labels. API§21 create3 explicitly supplies hypothesis; renaming changes only plan.title. Learning3 shows captured source IDs or a clearly unknown legacy set; never fabricate an empty count. An empty recorded set is a different state. Observation/method/criteria remain honestly nullable. No automatic status change or “Validated” badge follows model text; save needs a founder action and committed transaction. Criteria read-back adds no new edit field. The two mapping decisions are now approved, not outstanding owner choices; all implementation/accessibility tests remain unexecuted.

### 3.5 Research and evidence drawer

```text
Source detail
Finding: [scoped factual claim]
Publisher/title: [if known]
Observed: [date or “Unknown”]
Retrieved: [date or “Unknown”]
Geography: [region or “Not specified”]
Verification: Source checked ≠ claim proven
Limitations: [if present]
[Open source safely] [Close]
```

Research indicator distinguishes **queued, running, complete, insufficient evidence, failed, and unavailable** using the existing backend representations—not invented UI-as-server states. Turning off `proactiveResearch` prevents *new* automatic admissions; existing accepted research may continue. Links must use validated safe URL handling and not prefetch arbitrary sources.

### 3.6 Snapshot editor → approval → export

```text
Idea Snapshots                       [Create draft]

Draft Version 2                    [Editable]
[Contents and clearly labeled unknowns]
[Save draft] [Review]

Review Version 2                   [Read-only review]
[Request changes] [Approve this version]

Approved Version 2                [Immutable]
Content hash: [optional details]
[Export PDF] [Make new draft/version]

Export status: Queued / Running / Completed / Failed
If completed & artifact available: [Get fresh download link]
```

An approved revision is **not editable**. New content uses the existing POST /api/v1/ideas/{ideaId}/snapshots with full SnapshotCreate.content; API §14 expressly allocates a new draft version. No fork or review-transition endpoint is introduced. New-version UI sends no source/parent/clone field. Draft creation is synchronous201; no snapshot-AI job exists. Export is a separate explicit user action. A failed export does not mean the approved content disappeared. A completed export job does not necessarily mean the temporary artifact or signed link is still available; request a fresh owner-authorized grant.

### 3.7 Privacy & account deletion

```text
Account & privacy
[Export account data]    [Delete an idea]    [Delete account]

DELETE ACCOUNT confirmation
This blocks access immediately after acceptance.
Active-system cleanup target: within 30 days.
Backups/provider copies have separate retention policies.
[Reverify identity] [Cancel] [Request deletion]

After accepted deletion
Account deletion requested. Ordinary workspace access is blocked.
[Minimal operation status, only where authenticated access remains possible]
```

Do not show “All data erased” until the relevant backend operation confirms completion, and do not promise ongoing status access after the identity/session has been deleted. The 30-day live purge target is a design policy, not a measured SLA; backup/provider residuals are separate.

## 4. Design-system direction

### 4.1 Brand and visual personality (new proposals)

**Proposed character:** calm, analytical, respectful, human, approachable. Founder's Lens should feel like a focused thinking notebook—not a financial trading terminal, motivational app or social feed. Prefer uncluttered neutral surfaces, a restrained accent, comfortable long-form reading, and precise evidence labels.

**Palette proposal:** deep navy/slate text; warm off-white/light neutral surfaces; subdued teal/blue accent for interactive controls; amber for *caution*; red for *destructive/error*. Never encode claim truth or approval only by color. Dark mode can follow later once contrast-parity is proven; do not commit to both themes prematurely.

**Type proposal:** high-legibility system UI font stack; large readable body and stable tabular numerals for amounts/dates. Do not require downloadable custom fonts or visual brand assets. Hinglish uses standard Unicode; test fallback typography and number/rupee rendering.

### 4.2 Proposed tokens (not implementation CSS)

| Token family | Proposed values | Usage and guardrail |
|---|---|---|
| Spacing scale | 4, 8, 12, 16, 24, 32, 48, 64 px | Consistent rhythm; avoid densely packed controls |
| Radius | 8 px controls, 12 px cards, 16 px major panels | Visual distinction, not status authority |
| Border width | 1 px regular, 2 px high emphasis/focus | Focus must remain visible on all surfaces |
| Content measure | 680–760 px conversation reading column | Prevent unwieldy wide chat paragraphs |
| Desktop rail | Approx. 240–280 px, collapsible | Preserve chat width on narrow screens |
| Body type | 16 px default, line-height ~1.5–1.65 | Readability; must scale with browser settings |
| Small type | 14 px minimum for meaningful supporting text | Avoid tiny source/status copy |
| Title type | 24–32 px page titles; 18–22 px section headings | Responsive hierarchy; no fixed truncation of meaning |
| Motion | 120–200 ms subtle transitions | Disable nonessential motion when reduced-motion preferred |
| Focus indication | At least 2 px visible outline/offset | Verify nonobscured focus contrast |
| Touch targets | Aim ≥44 × 44 CSS px for primary interactive targets | Satisfy usable mobile/touch interactions |
| Overlay | High contrast scrim, keyboard-dismissible with safe Cancel during confirmation | Trap focus only inside modal; restore on close |
| Z-index tiers | page < sticky composer < nav/drawer < modal/toast | Avoid overlapping chat and dialog controls |

Do not treat proposed hex colors, contrast, brand or typography as approved: final tokens require contrast and visual QA. Aim for WCAG 2.2 AA: **4.5:1** contrast for normal text and **3:1** for large text and many non-text UI indicators, with applicable exceptions verified in audit. Color checks must use actual composited rendered colors.

### 4.3 Semantic color rules

| Meaning | Presentation | What not to imply |
|---|---|---|
| Primary action | One clear accent button per local decision area | Not multiple competing calls to action |
| Secondary action | Neutral outline/text | Not hidden essential action |
| Pending | Label + subtle icon/neutral treatment | Not “Approved” or “Saved” |
| Approved | Explicit word “Approved” + icon | Not perpetual download availability |
| Uncertain evidence | “Unverified” / “Insufficient evidence” + caveat | Not a confidence percentage invented by UI |
| Warning | Concise amber/neutral caution copy | Not user blame |
| Error | Clear copy and recovery path | Not just red border/spinner |
| Destructive | Explicit scope and confirmation | Not executed until server ack |

## 5. Reusable component catalog and contracts

Components are **visual boundaries only**. No component directly authorizes records, changes persistent state without a user action, or constructs privileged provider calls. All data sources flow from existing authenticated typed API adapters and trusted client state designed in Phase 4C.

| ID | Proposed component | Inputs / variants | Accessibility and correctness contract |
|---|---|---|---|
| UI-01 | AppShell | principal-scoped route, idea label, responsive mode | Landmarks, skip link, no cross-account cached label |
| UI-02 | IdeaSwitcher | owned ideas, selected ID, loading/empty | Accessible paginated list; client filter only within loaded owned rows, no server search endpoint |
| UI-03 | ConversationSwitcher | selected conversation, pagination | Keyboard list semantics; maintain selected logical turn |
| UI-04 | ChatTranscript | authorized selected-turn messages, representation version | Stable reading order; selected assistant response only |
| UI-05 | ChatBubble | speaker, safe text, real timestamps | Clear speaker labels; no unsafe raw HTML |
| UI-06 | ChatComposer | local draft, admission status, input limits | Multiline IME safe; accessible Send/Stop |
| UI-07 | GenerationStatus | six durable states + distinct transport state | Announce milestones, not every token; no false cancellation |
| UI-08 | AssistantCard | one approved variant: assumption/evidence/comparison/experiment | At most one; structured allowlist; no arbitrary HTML |
| UI-09 | ContextualActions | zero to two approved presentation intents | Actions map to explicit authorized commands; confirmation where required |
| UI-10 | CitationDisclosure | verified source IDs and scoped details | Link labels meaningful; date/scope/unknown explicit |
| UI-11 | ResearchControl | current conversation preference/version and status | Toggle commits via If-Match; separate accepted-running work |
| UI-12 | MemoryProposalCard | proposal status, source, version | Edit/accept/dismiss confirmed only after backend commit |
| UI-13 | ConfirmedMemoryRow | current version, kind, status | Correct/remove/revision history; no model restore |
| UI-14 | AssumptionRow | statement, provenance, verification status | Avoid unsupported “proven” badge |
| UI-15 | ExperimentPanel | hypothesis, plan, measured results | Observation distinct from interpretation |
| UI-16 | SnapshotReview | draft/review/approved content and version | Approved view read-only; draft revision guard |
| UI-17 | ExportStatusPanel | job status, artifact availability, grant expiry | New grants requested explicitly; no signed URL in application navigation, telemetry or persistent cache (network/download artifacts cannot be guaranteed absent) |
| UI-18 | ConfirmationDialog | action scope, side effects, cancel/confirm | Proper focus, escape policy, no accidental destructive default |
| UI-19 | AsyncState | loading/empty/offline/unknown/error/retry | Honest status; retry must preserve accepted intent IDs |
| UI-20 | Notice/Toast | server-confirmed success/info/error | Never claim success on button click before acknowledgment |

### 5.1 UI-08 card variant rules

**Assumption:** state as hypothesis; clearly state evidence unknown/partial; optional link to existing assumption.  
**Evidence:** exact claim and meaningful provenance; “source checked” does not mean business claim proven.  
**Comparison:** 2–4 options where data exists; no fabricated scores.  
**Experiment:** a proposed feasible test and measurable success signal; **not automatically a saved experiment**.

One optional card per assistant turn. A malformed/unsupported card must not be force-rendered; only a safe independently validated text fallback is allowed under the approved server contract. Never create a card merely because the UI can display one.

### 5.2 UI-07 truthful generation states

| Backend / transport fact | Recommended visible wording | Available action |
|---|---|---|
| Local submit not acknowledged | “Sending…” | Avoid duplicate submission; check uncertain status |
| PENDING | “Message saved. AI is queued.” | Navigate without cancelling |
| RUNNING | “Thinking…” + safe transient text | Explicit Stop; keep last durable status recoverable |
| CANCEL_REQUESTED | “Stopping…” | No false terminal completion |
| COMPLETED | Durable message shown after GET | Continue; optional regenerate where eligible |
| FAILED | “Could not complete this response.” | Retry only by permitted new intent |
| CANCELLED | “Response cancelled.” | New input or permitted regenerate |
| SSE disconnected | “Connection interrupted; checking status…” | Status GET/poll, not auto cancel |
| Research pending | “Research is still in progress.” | Inspect accepted job if exposed |
| Context changed | “The information changed before this response could be saved.” | Continue with updated context |

## 6. Interaction patterns and microcopy

### 6.1 Saving versus suggesting

- **Suggest:** “You could test this idea by…” means AI text only.
- **Draft:** “Experiment proposal” means no durable experiment has been created.
- **Save request:** Explicit founder action starts the existing API operation.
- **Saved:** Display only after the API confirms acceptance and canonical state; reconcile uncertain network responses before claiming success.
- **Review/approve:** Show version and consequences; `If-Match` conflict causes comparison, not hidden overwrite.

### 6.2 Suggested user-facing error copy

| Situation | Example wording | Next step |
|---|---|---|
| Network uncertain after send | “We're checking whether your message was saved. Don't resend it as a new message yet.” | Reconcile same intent/key |
| 412 stale version | “This item changed elsewhere. Review the latest version before saving.” | Refresh + compare |
| Quota reached | “You've reached the current usage limit. No new request will be sent automatically. Check the status of any earlier request.” | Explain available option/limit, no hidden retry |
| Research unavailable | “We couldn't check new sources right now. Here's what we can say without fresh research.” | Mark uncertainty |
| Evidence out of scope | “This source may not apply to your location or time period.” | Open scope details |
| 404 foreign/missing | “This page isn't available.” | Return to owned ideas; no existence leak |
| Generation SSE lost | “Live updates disconnected. The response may still be running.” | Check durable status |
| Export artifact expired | “This download is no longer available. You can request a fresh export if the approved snapshot is still accessible.” | New export or grant as allowed |
| Delete accepted | “Your account is now inaccessible. Cleanup is in progress.” | Minimal status only if permitted |

Microcopy must be tested for English and typed Hinglish inputs; localization of the interface itself is not assumed. Never write promotional promises such as “100% private,” “AI verified,” “instant permanent deletion,” or “guaranteed success.”

## 7. Accessibility and inclusive design

### 7.1 Keyboard and focus acceptance

- Navigation landmarks and skip link; predictable order through idea switcher, tabs, conversation, card and composer.
- Tab/Shift+Tab reaches every control. Dialog opens with meaningful initial focus; Escape closes nondestructive dialog; focus returns to trigger. Destructive confirmation must never be the preselected focus if accidental activation is possible.
- Send on Enter versus Shift+Enter is a proposed interaction; consider IME composition and alternative explicit Send button; no lost text during Unicode composition.
- If the user scrolls older transcript, avoid force-scrolling down with each delta. Provide “Jump to latest” with accessible label.
- Status announcements are **coalesced** at major lifecycle milestones, not streamed token-by-token; screen readers must not be flooded.
- Evidence expansions disclose state; toggles include clear name and actual saved on/off status.
- Display card details as semantic headings, lists, and labels—not visually positioned text requiring sight to understand.

### 7.2 Responsive and zoom acceptance

- Test at 320/360/390 px; landscape; 200% zoom and 400% zoom; large text; system font overrides; keyboard open; reduced-motion.
- No critical composer button behind browser keyboard, bottom tabs, toast or fixed panel.
- At narrow sizes, text and actions wrap vertically; avoid horizontal scrolling of primary reading content. Exceptional data tables may use localized scrolling with accessible labels.
- Ensure warnings, errors and statuses are presented as text and icon (not color alone). Verify contrast using actual token values after visual selection.
- On slow connections, skeletons must not endlessly hide real empty/error states; long-running work uses real textual status.

## 8. Motion, loading and responsive transitions

- Favor instant or brief transitions; avoid animated typing that implies generated content exists before validated persistence. During RUNNING show safe transient fragments, but distinguish them from saved text until GET confirms finalization.
- Use `prefers-reduced-motion`-respecting behavior for drawer/modal transitions, loading animations and any decorative illustration.
- Prefer stable layout for moving between Think/My Idea/My Learning; when returning to a conversation, keep selection and draft consistent with privacy and navigation rules.
- Loading indicators are not a substitute for retry/reconciliation. A spinner must have status text and a meaningful timeout/attention state.

## 9. Data safety in interface layout

1. Hide nothing only for “security”: server always enforces idea ownership and lifecycle; a hidden button is not authorization.
2. Keep private idea titles, transcript text and evidence out of SEO/public metadata and generic analytics.
3. Use opaque IDs in routes; never put ideas, prompts or signed export grants in URL query parameters.
4. Clear scoped caches/observers on logout, principal change or accepted account deletion.
5. Never persist private transcripts/composer text;FE4D-A03 permits only bounded session-scoped opaque recovery IDs under4C§19,with isolation/expiry/cleanup.
6. Don’t ask browser to fetch arbitrary research URLs as previews; use the approved safe-link handling contract.
7. Do not display raw provider debug output, prompt instructions, hidden reasoning or internal quality flags.
8. A new account using the same email receives an empty workspace; never restore old-client cached data into it.

## 10. Screen-state matrix

| Screen | Loading | Empty | Error/offline | Success/terminal |
|---|---|---|---|---|
| Idea chooser | Stable list skeleton | Create first idea | Safe retry/connection note | Authorized ideas only |
| Think | Load selected transcript | Free-text invitation | Lost acceptance/status recovery | Durable selected assistant response |
| My Idea | Separate section loaders | “No assumptions/memory yet” | Version conflict/refresh | Approved states accurately labeled |
| My Learning | Load experiments | “No experiments recorded yet” | Save uncertain/retry safely | Observations and interpretations separate |
| Research source | Fetch only permitted data | “No relevant sources yet” | Unknown/stale source visible | Provenance + caveats |
| Snapshots | Load list/preview | Create draft | Validation/409/412 conflict | Approved immutable revision |
| Export | Fetch job status | No export requested | Failed/expired link | Fresh authorized download grant |
| Privacy | Fetch policies/status | No pending operation | Reauth required/unavailable status | Deletion accepted vs completed distinct |

No screen invents data from missing backend fields. Exact representation shapes are mapped in 4C§8/21; missing fields remain explicit gaps.

## 11. Test and review plan — not executed

All scenarios below are **planned**. They are not usability research results, screen-reader certifications, implemented components or browser-test passes.

| ID | Scenario | Acceptance oracle |
|---|---|---|
| FE4B-01 | New founder from public landing | Auth before AI, no long mandatory questionnaire |
| FE4B-02 | First idea creation | Free-text start with explicit server-confirmed creation |
| FE4B-03 | Returning founder | Select owned idea and continue correct conversation |
| FE4B-04 | Desktop layout | Chat primary, navigation discoverable, reading width comfortable |
| FE4B-05 | Mobile at 320 px | Composer, navigation, card and actions accessible without clipping |
| FE4B-06 | Mobile keyboard open | Send/Stop and text remain visible/reachable |
| FE4B-07 | Long Hinglish text and emoji | Preserved Unicode, wrapping, cursor and IME behavior |
| FE4B-08 | Reduced motion | Nonessential motion suppressed without lost status |
| FE4B-09 | Keyboard-only use | Complete Think and memory flow without pointer |
| FE4B-10 | Screen-reader live generation | Major milestones announced, individual tokens not spammed |
| FE4B-11 | One card/two actions | No extra prominent actions or multiple cards |
| FE4B-12 | Malformed structured content | No raw HTML/JSON, safe validated fallback only |
| FE4B-13 | Pending message vs accepted | “Saved” only after confirmed HTTP acceptance |
| FE4B-14 | SSE disconnect while generating | Status reconciliation; no implicit cancellation |
| FE4B-15 | Explicit cancellation | “Stopping” pending, “Cancelled” only when terminal |
| FE4B-16 | Lost 202 / repeated Send | Same intent identifiers; no duplicate durable message |
| FE4B-17 | Research toggle switched off | New automatic research disabled after saved setting; accepted job honest |
| FE4B-18 | Unknown/stale source | Date/geography/uncertainty clearly labeled |
| FE4B-19 | Citation link safety | No arbitrary HTML or unvalidated URL previews |
| FE4B-20 | AI proposes memory | Visually pending, no silent acceptance |
| FE4B-21 | Two-tab memory update | 412 shows comparison, not silent overwrite |
| FE4B-22 | Removed memory | Known-linked obsolete content excluded from fresh active summaries/chips; semantic removal is imperfect |
| FE4B-23 | Assumption card action | Explicit save; experiment not auto-created |
| FE4B-24 | Observation vs learning | User observation distinguished from interpretation |
| FE4B-25 | Approved snapshot edit | Original immutable; new draft/version only |
| FE4B-26 | PDF job complete with expired artifact | No misleading usable link; legitimate new grant/export |
| FE4B-27 | Account deletion acceptance | Immediate private UI clearing and truthful purge language |
| FE4B-28 | New identity same email | Fresh empty account; no cached former workspace |
| FE4B-29 | Foreign resource link | Privacy-preserving unavailable page |
| FE4B-30 | Zoom/contrast/focus review | WCAG-oriented manual and automated evidence |
| FE4B-31 | Full keyboard snapshot approval | Focus flow and no accidental approval |
| FE4B-32 | Regeneration and transcript pagination | Selected logical-turn order maintained |
| FE4B-33 | Multiple loading/errors | State text meaningful; no infinite spinner |
| FE4B-34 | Legacy/structured transcript switch | No invented card or strategy for legacy/user rows |
| FE4B-35 | Privacy-oriented logging checks | No prompts, full source text or grant URLs in telemetry |
| FE4B-36 | Long names, multiple cards in source test fixture | Labels wrap; malformed extra card rejected by contract |

**Methods:** low-fidelity walkthrough with representative early-stage founders; keyboard/assistive-tech manual review; contrast inspection after token color selection; visual viewport matrix; component-level behavior tests planned in 4C; Playwright and cross-browser E2E during implementation; synthetic backend failure fixtures; usability review of labels/action priority. No numerical success rates are asserted.

## 12. Traceability and reconciliation

| Phase 4B element | Phase 4A authority | Existing approved requirement/contract family |
|---|---|---|
| First-use/idea chooser | FJ-01/FJ-02, §4–5 | Auth-before-AI; conversation-first FR-013–021 |
| Think/composer/stream | §8–9; FE4A-06–12,26,29 | Phase 2C six-state generation and SSE; Phase 3 single card |
| Memory review/removed state | §10.1; FE4A-15–18 | P2D-P04/P3-P03; If-Match and contextEpoch |
| Research/evidence | §9–10.2; FE4A-13/14 | FR-034–040, provenance/admission controls |
| Experiment/learning | §10.2; FE4A-19 | FR-029–033; confirmed vs proposed effects |
| Snapshot/export | §10.3; FE4A-20/21 | P2D-P05; draftRevision, immutable approval, fresh grant |
| Privacy/deletion | §10.4; FE4A-22/23/28 | P2D-P01–03, 30-day active-system target separated from backups |
| Mobile/keyboard/contrast | §5/11; FE4A-03/24/25 | NFR-014/019; accessibility acceptance |
| Cache/analytics | §7/12; FE4A-28 | Principal/idea isolation and no private telemetry |

**Known contract dependencies:** `assistantResponseVersion=2`, actual optional `assistantContent` DTO, card variants, research-job enums, version headers, deletion status rules and exact route surfaces must be reconciled against current canonical files by Codex during 4C/4D. Illustrative wireframes do not add endpoints or fields. Avoid claiming source-level full compliance without access to the repository.

## 13. New Phase 4B decisions requiring review

| ID | Proposed choice | Recommendation | Status / owner |
|---|---|---|---|
| FE4B-D01 | Visual personality and brand palette | Calm professional light-neutral direction;exact tokens provisional | Approved direction FE4D-A02;visual/accessibility validation pending |
| FE4B-D02 | Responsive navigation | Think primary;idea-scoped supporting My Idea/My Learning/Snapshots | Approved direction FE4D-A01;responsive/usability tests pending |
| FE4B-D03 | Content density | Text-first 680–760 px main reading width; optional details on demand | Proposed — product/UX |
| FE4B-D04 | Core spacing/type/radii and breakpoint scale | Use provisional tokens; validate on real screens and zoom | Proposed — UX/engineering |
| FE4B-D05 | Assistant strategy label | Subtle optional label, never score or mandatory stage | Proposed — product/UX |
| FE4B-D06 | Pending/error/success microcopy | Truthful language with recoverable actions and no overclaims | Proposed — product/content |
| FE4B-D07 | Source disclosure | Expandable evidence summary, explicit region/date/unknown status | Proposed — UX/research |
| FE4B-D08 | Composer interactions | Explicit Send/Stop, IME-safe multiline behavior | Proposed — accessibility/engineering |
| FE4B-D09 | Modal and sticky-layer behavior | Focus-safe confirmations; no obscured composer/nav | Proposed — accessibility |
| FE4B-D10 | Draft and local UI persistence | Private text memory-only;approved bounded session opaque IDs with isolation/cleanup | Approved principle FE4D-A03;TTL/browser proof pending |
| FE4B-D11 | Visual token colors/dark theme | Finalize contrast-checked palette and theme scope later; do not infer approval | Pending visual review |
| FE4B-D12 | Route, auth and API integration specifics | See4C§8/20/21 current mapping, inherited Bearer and explicit DTO gaps | Pending Implementation/Provider Validation |

These recommendations do **not** reopen owner-approved Phase 2D/3 principles. There is no implied owner approval merely because this document exists.

## 14. Phase 4B exit criteria and Phase 4C handoff

Current reconciliation: 4D owns review outcomes; 4C §§8,19–20 own wire/recovery/auth. Earlier handoff instructions describe original preparation, not an authorization to implement.

**Sign-off-ready documentation requires:** agreement on navigation/content hierarchy and principal screen flows; accessible responsive patterns; approved or explicitly deferred design tokens; no contradiction with Phase 2D/3 cardinality, memory, consent, research, SSE, snapshot or deletion behavior; open decisions assigned owner; updated document reference map; exact reviewed revision fingerprint. No implementation or user-testing pass is presumed.

**Handoff to Phase 4C — Frontend State & API Integration:** define the canonical frontend route choice, Clerk/session transport, state ownership, query keys and invalidation, API endpoint/request/response mapping, message send/recovery sequence, SSE lifecycle observer, form/If-Match error state machines, structured representation fallback, confirmation actions and privacy-safe telemetry. Reconcile against the actual repository OpenAPI and approved revision manifests before freezing. Do not create a parallel Next.js business API or silently modify backend contracts.

**Canonical location:** Docs/lld/06-frontend/wireframes-and-design-system.md. Existing filenames remain stable.

---

**Final status:** Phase4B v0.5, `FL-P4-0.5-approved` — Approved, Documentation Only under FE4D-A08. Navigation/light-neutral/recovery principles are approved design; exact tokens and measured accessibility remain provisional. No application implementation, test execution or certification is approved.

## 15. Reconciled token and accessibility contract

§4.2 remains the sole provisional token catalog: compact<768px,medium768–1023px,wide>=1024px;spacing4/8/12/16/24/32/48/64,reading measure680–760,body16,supporting14,rail240–280,motion120–200ms. FE4D-A02 explicitly approves the professional light-neutral direction,not exact token values ormeasured compliance. No hex palette ordark theme is selected. Respect available width,reflow/user settings andfuture accessibility measurements;A/C/D reference this catalog rather than duplicate scales.

Accessibility acceptance is normative design intent under SRS NFR-014/019, not a tested compliance claim. Keyboard: skip link, landmarks, visible non-obscured focus, correctly labeled buttons/toggles, roving focus only where appropriate, no focus trap except modal; dialogs restore focus, permit safe Escape/cancel and never default-focus irreversible confirmation. Composer: explicit Send/Stop always reachable, Enter-send only outside IME composition, Shift+Enter newline, mobile/assistive input has an explicit button alternative. No gesture-only control. Announce queued/running/stopping/terminal once, never each delta; avoid duplicate nextQuestion in prose and metadata. Preserve reading position/focus through pagination/regeneration.

Review at320 CSSpx equivalent,200% text enlargement and400% zoom with reflow and no loss of essential controls; test keyboard-open portrait/landscape, forced colors, system fonts, long Hinglish and reduced motion. A44 px primary touch target is a project usability aim; WCAG2.2 AA criterion2.5.8 uses24x24 CSSpx with defined exceptions. Do not mislabel44 px as universal AA law. Verify rendered text4.5:1 (large text3:1) and applicable UI/nontext3:1, including focus, errors and disabled-state exceptions in a real browser. [W3C reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html), [target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html), [contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) govern criterion interpretation.

Manual release plan (not executed): Chromium/Firefox desktop keyboard, Safari desktop/mobile VoiceOver, Android Chrome/TalkBack and Windows screen reader with Chromium/Firefox; pin actual versions/device access at implementation. Automated accessibility checks supplement manual tests; unavailable combinations remain explicitly untested. Test auth, send/stop, source disclosure, memory conflict, draft/approval/export and deletion through success/empty/loading/error/offline states. FE4B-01–36 and F4D scenarios remain planned.
