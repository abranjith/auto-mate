# MVP Plan: Auto-Mate

**Status:** Working draft — awaiting user decisions; not ready for implementation.
**Started:** 2026-09-10
**Purpose:** Reconcile the existing plan and three reviews into a coherent implementation plan for tech-savvy people who may not be programmers.

## 1. Sources and decision rules

- [Original plan](plan.md)
- [Earlier criticism](plan.criticism.md)
- [Claude feedback and phase split](plan-feedback-claude.md)
- [Product and architecture critique](reviews/plan_critique.md)
- [Existing project memory](memory.md)
- [Existing data model](data_model.md)
- User-supplied implementation reference: `E:/ai/yantra/packages/agent/src` (inspected read-only for the provider-interface pattern; not a runtime dependency).

The user explicitly requested clarification whenever something conflicts or is unclear. Review recommendations are proposals, not accepted requirements. This draft records unresolved choices instead of selecting among them. Existing project decisions remain the baseline wherever they are clear and do not conflict with the proposed revision. Any approved overrides will be stated explicitly in this document.

The original plan and reviews remain separate reference documents. This draft does not yet supersede the original plan or change project memory, feature specifications, or the data model.

## 2. Established direction

- The target audience is tech-savvy people who need not be programmers.
- The product provides a user interface for describing work and obtaining useful results without requiring the user to write code.
- The existing product direction includes local ownership, persistent results/history, and eventual task reuse.
- This work produces a revised plan; it does not begin application implementation.

### Confirmed initial product

The initial product supports **CSV/XLSX preparation and reporting**. Broader task types follow later. Basic **save-and-rerun with another file** belongs in the initial scope; a richer reusable-task gallery follows later.

The first milestone is an **explicitly unisolated developer-only preview**. Restricted execution is required **before a target-user pilot**. This distinction applies to both generated tests and final scripts. The preview must not describe its working directories or Python environments as security isolation. The restricted runner technology is not yet selected.

These choices establish the following milestone boundaries; detailed features and acceptance criteria remain pending:

| Milestone | Confirmed purpose and boundary |
| --- | --- |
| Developer preview | Build the CSV/XLSX preparation/reporting loop and basic save-and-rerun. Generated code runs without an enforced isolation boundary, explicitly for developer use. |
| Target-user pilot | Retain the same core product loop; restricted execution must be in place before tech-savvy non-programmers participate. |
| Later expansion | Broader task types and a richer reusable-task gallery. Scheduling, URL ingestion, standalone artifact library, gamification, generated tools, and connectors are deferred until after the pilot and are candidates rather than committed deliverables. |

Basic history, downloads, and save-and-rerun remain in initial scope. Deferring the standalone artifact library does not remove access to outputs in execution history.

### Confirmed clarification behavior

The app asks a user when ambiguity changes the meaning of the task or risks data loss. It chooses defaults for cosmetic details. This supersedes both the original broad feature/preference questioning policy and Claude's proposal to default all questions in the developer preview. It does not change the separate instruction to clarify unresolved planning decisions with the project owner.

### Confirmed data disclosure policy

During generation and repair, the app supplies **column names/types, locally computed statistics, and small sample rows disclosed before sending** to the configured AI provider. Full input files remain outside the model's context. The same policy applies to repair prompts and diagnostics; a failed run does not authorize sending the full dataset.

This is the approved application data-flow policy. The developer preview's lack of process isolation remains explicit: it must not claim that generated code is technically unable to access other host files. Sample size, disclosure interaction, and diagnostic filtering details remain to be specified.

### Confirmed Python runtime and verification policy

The initial CSV/XLSX product uses **Python only with a fixed, preinstalled dependency set**. Shell-script output and task-specific installation of additional packages are deferred. The exact dependency set and version/update policy remain open; this decision replaces the original MVP's Python-plus-shell scope and arbitrary-package approval flow.

The **agent generates, tests, and repairs code; the application independently checks the final version and enforces execution gates and attempt/time limits**. The application must associate verification results with the version of code being executed; agent progress messages alone do not authorize execution. The app does not need to direct every internal agent repair step. Exact check contracts and limit values remain open.

### Confirmed AI integration: Pi behind a thin interface

Use **Pi coding agent** for AI provider/model configuration and interaction. Auto-Mate consumes it through a thin provider interface following the Yantra pattern. The prior suggestion to restrict the preview to one cloud configuration is **not adopted**. Provider availability/configuration comes through Pi; a model quality/acceptance test matrix is a separate unresolved planning detail.

The inspected reference provides these concrete boundaries:

| Boundary | Pattern to carry into Auto-Mate | Reference |
| --- | --- | --- |
| Provider interface | SDK-independent `AgentProvider.open(options)` creates an application-facing session. | `E:/ai/yantra/packages/agent/src/provider/types.ts` |
| Session lifecycle | `run(prompt)`, `subscribe(listener)`, `abort()`, and `close()` expose the operations the application consumes. | `provider/types.ts` |
| Pi adapter | Implements that interface and keeps SDK session construction/model lookup inside the adapter. | `adapters/pi/provider.ts` |
| Events and outcomes | Translate SDK events into application-owned tool events, assistant text, usage, failures, and terminal outcomes; sanitize data crossing the interface. | `adapters/pi/event-map.ts` |
| Configuration | Follow Yantra: app-owned model/settings/session files with optional use of an existing personal Pi credential file. | `adapters/pi/environment.ts` |

No Pi SDK types should appear in the application-facing provider contract. Do not reproduce Pi's provider registry or internal agent loop in Auto-Mate. Auto-Mate still owns task state, file disclosure, verification gates, script execution, and output handling; delegating AI configuration does not delegate those responsibilities.

The user confirmed the Yantra configuration approach: keep model configuration, settings, and sessions under Auto-Mate's control and optionally use a personal Pi credential file. Selecting that credential source does not import personal Pi settings, extensions, skills, or project instructions. The exact storage location follows the still-pending storage decision.

The reference's package manifest currently pins `@earendil-works/pi-coding-agent` to `0.80.6`. This is an observed reference version, **not an automatically selected Auto-Mate version**. Likewise, Yantra's browser/workflow tools, configuration projection, credential-storage details, and raw session-log handling are not automatically imported into this plan. The existing pi-web-ui choice needs an explicit integration decision because the original plan forwards raw SDK events, whereas the thin interface exposes normalized application events.

## 3. Decisions requested first

| ID | Decision | Conflict to resolve | Status |
| --- | --- | --- | --- |
| D01 | Initial supported task types | CSV/XLSX preparation and reporting first; broader tasks later. | Confirmed by user, 2026-09-10 |
| D02 | Timing of basic task reuse | Basic save-and-rerun initially; richer gallery later. | Confirmed by user, 2026-09-10 |
| D03 | Initial execution/deployment approach | Explicitly unisolated developer-only preview; restrict execution before a target-user pilot. Restricted runner technology remains open. | Milestone boundary confirmed by user, 2026-09-10 |
| D04 | Data disclosure and inference | Disclosed schema, local statistics, and small sample rows for generation/repair; full files outside model context. Pi manages provider/model configuration through a thin interface. | Confirmed by user, 2026-09-10 |
| D05 | Languages and dependencies | Python only with a fixed, preinstalled package set; defer shell scripts and additional package installation. | Confirmed by user, 2026-09-10 |
| D06 | Clarification behavior | Ask when ambiguity changes meaning or risks data loss; default cosmetic details. | Confirmed by user, 2026-09-10 |
| D07 | Verification ownership | Agent iterates; app independently checks final code and enforces execution gates and attempt/time limits. | Principle confirmed by user, 2026-09-10; limits and review UX still open |
| D08 | Later feature scope | Defer scheduling, URL ingestion, standalone artifact library, gamification, generated tools, and connectors until after the pilot; treat them as candidates. | Confirmed by user, 2026-09-10 |
| D09a | AI provider abstraction | Pi coding agent behind a thin provider interface following the inspected Yantra pattern. | Confirmed by user, 2026-09-10 |
| D09b | Pi configuration ownership | App-owned configuration with optional personal Pi credentials; follow Yantra. | Confirmed by user, 2026-09-10 |

## 4. Remaining decisions to resolve after scope

These are the remaining portions of the decision inventory, not approved defaults. Questions will be presented in related groups; confirmed answers above take precedence over older proposals.

| ID | Decision | Why clarification is necessary |
| --- | --- | --- |
| D04 | Privacy details | Define disclosure interaction and bounded sample/diagnostic rules consistent with the approved data-flow policy. |
| D05 | Dependency details | Select the fixed Python dependency set and its version/update policy; Python-only and no per-task installation are confirmed. |
| D06 | Clarification limits | Behavior is confirmed. The original five-question cap and unresolved-critical-question handling will be covered with operational limits. |
| D07 | Approval UX and limits | Verification ownership is confirmed. Define pre-run intent review, post-run acceptance, exact repair limits, and whether execution outcome and user review are separate. |
| D09 | Runtime and integration choices | Pi/thin interface and configuration ownership are confirmed. Asked about pi-web-ui with a rendering adapter and compatibility proof, plus TanStack Router/better-sqlite3 and verified exact versions. Vendoring is not approved. |
| D10 | Authoritative state and local access | Asked about server-owned task/conversation state and Pi credentials, REST commands, WS progress/recovery, loopback-only access, and local session protection without accounts. |
| D11 | Reuse and data model | Asked about separate templates with immutable revisions, recorded inputs/parameters/runtime, and explicit mapping/repair that creates a revision for approval. Historical replay details still need specification. |
| D12 | Outputs and retention | Decide required output formats, generated HTML versus trusted renderers, standalone offline exports, independent saved artifacts, retention of inputs/provenance, storage layout, and application data root. |
| D13 | Installation and platform support | Define which Windows/Unix hosts must work at the first milestone, setup expectations, and whether the first audience is developers or target users. |
| D14 | Operational limits and acceptance | Resolve three versus five attempts, time/resource/spend limits, file limits, concurrency, and concrete acceptance gates. The reviews' timing and pilot targets are unapproved proposals. |
| D15 | Scheduling semantics | Deferred with scheduling until after the pilot. No scheduling implementation is part of this MVP; a later proposal must define fresh inputs, timezone, overlap, missed runs, sleep, and unattended review. |

## 5. Review findings to carry into the design

The sources identify the following concerns to address. Their implementation and milestone assignment remain subject to the decisions above.

- Cancellation must cover generation, generated tests, dependency preparation, and real execution.
- Verification must establish what was actually checked and which exact code/runtime those results apply to.
- Reuse needs input compatibility checks and recorded rules, inputs, parameters, and environment.
- Failure messages must help a person who cannot debug code take the next step.
- Browser disconnects and server restarts need defined outcomes and state recovery.
- Artifact paths, registration, rendering, deletion, and retention need a consistent lifecycle.
- Data disclosure and diagnostic logging need to match the stated privacy behavior.
- Acceptance must test useful, correct results and repeat use, rather than successful process exit alone.
- Scheduling requires a source of fresh input and an explicit downtime policy.
- Existing plan, memory, and data-model inconsistencies must be reconciled explicitly before downstream implementation.

Technical assertions disputed by the reviews will be checked against primary documentation when their design is finalized. User questions will address product choices and trade-offs rather than asking the user to arbitrate technical facts.

### Technical evidence checked during planning

- The original `@mariozechner/pi-web-ui` package is marked deprecated by its publisher, pointing to `@earendil-works/pi-web-ui`. If the user retains pi-web-ui, the compatibility proof must target the maintained package identity rather than copying the original plan's imports. This does not select a package version or prove UI integration. [Publisher's package notice](https://www.npmjs.com/package/%40mariozechner/pi-web-ui).
- `uv run` can update its lockfile/environment automatically; `--locked` prevents lockfile changes and errors on an outdated lockfile. The fixed dependency policy therefore needs explicit locked setup/run behavior rather than relying on a bare `uv run` invocation. Exact commands remain part of the runtime proof. [uv locking and syncing documentation](https://docs.astral.sh/uv/concepts/projects/sync/).

## 6. Final plan structure to complete after decisions

1. Product promise, target jobs, and success criteria.
2. Initial scope, exclusions, and later milestones.
3. User journeys, clarification, review, and recovery experience.
4. Selected stack and explicit overrides to existing memory.
5. Architecture and execution/information boundaries.
6. Domain model, immutable revisions, and persistence ownership.
7. API/event contracts and execution lifecycle.
8. Feature breakdown, dependencies, and milestone mapping.
9. Installation, operational limits, and failure handling.
10. Testing, acceptance gates, logging, and retention.
11. Review disposition and user decision record.

## 7. User decision record

| Date | Decisions | User answer |
| --- | --- | --- |
| 2026-09-10 | D01 | CSV/XLSX preparation and reporting first; broader tasks later. |
| 2026-09-10 | D02 | Basic save-and-rerun in the first pilot; richer gallery later. |
| 2026-09-10 | D03 | Start with an explicitly unisolated developer-only preview; restrict execution before a user pilot. |
| 2026-09-10 | D04 | Accept recommendation: schema/types, statistics, and small sample rows disclosed before sending; full files outside model context, including repair. |
| 2026-09-10 | D05 | Accept recommendation: Python only with a fixed, preinstalled package set; defer shell scripts and additional package installation. |
| 2026-09-10 | D07 | Accept recommendation: agent generates/tests/repairs; app independently checks final code and enforces gates and attempt/time limits. |
| 2026-09-10 | D09a | Use Pi coding agent for AI configuration behind a thin provider interface; follow `E:/ai/yantra/packages/agent/src` as the pattern. |
| 2026-09-10 | D09b | Follow Yantra: app-owned configuration, optional personal Pi credentials. |
| 2026-09-10 | D06 | Ask when ambiguity changes meaning or risks data loss; default cosmetic details. |
| 2026-09-10 | D08 | Defer scheduling, URL ingestion, standalone artifact library, gamification, generated tools, and connectors; treat them as later candidates. |

Current questions are pending for chat UI integration, router/database/version selection, authoritative state/transports/local access, and versioned task reuse. Recommendations in unanswered questions are not accepted defaults.
