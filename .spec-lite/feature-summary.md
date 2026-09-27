<!-- Maintained by spec-lite | updated by: implement, fix skills -->

# Feature Summary

> Current implemented behavior only. Change history lives in source control.

## Saved tasks

**FEAT-111 — Save and rerun** _(updated: 2026-09-26 by implement)_  
Source spec: [spec.md](features/FEAT-111-save_and_rerun/spec.md)

Only an accepted (`completed`) run can be saved (**Save this task**, `POST /api/executions/:id/save`). Saving copies its code under the same digest, its input contract (formats, sheets, column names and types, required flags, and no rows or values), its pre-flight and clarification answers as semantic rules, and the approved runtime into revision 1 of a saved task. Revisions are immutable by database trigger and only append; a saved task survives deleting its source task, and the delete-task dialog says so. **Saved tasks** lists them with revision, last run, and run count, and each detail page shows what it expects and produces, remembered choices, runtime, clock-read warnings, revisions, runs, and code on request.

**Run with another file** checks each slot's stored profile against the contract (blocking, advisory, and informational findings worded in `wording.ts`) and binds the new upload to the input name the code reads. A compatible file runs the saved code as a new task (`pending → verifying`), re-runs its tests on a fixture synthesized from the new file, and waits at the **Run it** approval and the result review, with no provider session and no transmission. A mismatch is mapped by the person (column, sheet, or decision), rendered as fixed sentences, and repaired by the AI under the new file's disclosure consent without the saved code; an accepted repair can be promoted to revision N+1.

Every execution records an as-of instant, date, zone, and source, passed to Python as `AUTOMATE_AS_OF`, `AUTOMATE_AS_OF_DATE`, and `AUTOMATE_TIMEZONE`. **Run again exactly** on a saved-code run reuses its code, inputs, and as-of date on today's runtime, and the approval gate names any runtime change. Rejecting a saved-code run records the feedback and offers **Repair with AI** or **Run again exactly** instead of starting an AI retry, and FEAT-106's retry refuses saved-code runs. Compatibility is about shape, not meaning.

---

## Execution History

**FEAT-110 — Execution History** _(updated: 2026-09-26 by implement)_
Source spec: [spec.md](features/FEAT-110-execution_history/spec.md)

History lists one row per task with its latest run, text search, status filters, a **Needs you** strip, and keyset paging. A task has a paged timeline; each run has a stable URL, its transcript and outputs, and a provenance summary that expands through the owning feature's views. **Run again** creates a linked run with optional guidance, reopens disclosure review if consent is stale, and refuses when another run of the task remains open.

Whole-task deletion removes database rows first and then the task's upload and artifact trees plus each execution's run, script, and raw agent-session trees. Startup cleanup removes residue after interrupted deletion; attached records are never purged by age. `pending`, `generating`, `verifying`, `executing`, and `waiting` interrupt on restart with phase-specific messages, while approval and review gates survive. Graceful shutdown records a separate reason. The API adds list, timeline, record, and delete routes plus task counts, with `nosniff` on all `/api` responses. Restart reconciliation, the parked-run lookup, and **Needs you** are served by the `execution_active` and `execution_parked` partial indexes, whose status lists are written as literals. The end-to-end suite covers prior outputs, the restart partition including gates that still work after a restart, one open run per task, deletion of every row and file with an outside link left intact, startup cleanup, and a provider that must never be opened. This preview relies on browser same-origin policy for history reads; it has no local account access control.

---

## Results & Outputs

**FEAT-109 — Results, Outputs & Downloads** _(updated: 2026-09-25 by implement)_
Source spec: [spec.md](features/FEAT-109-results_outputs_downloads/spec.md)

When a run settles, every file the script wrote — declared in `manifest.json` or not — is moved into `artifacts/{taskId}/{artifactId}{ext}`, digested, typed from a fixed nine-type policy (never `.svg`), and recorded; undeclared files are kept and marked, and files that cannot be kept are counted and shown, never fatal and never changing where the run lands. The result panel lists each output with a viewer and a download: server-paged tables for CSV/XLSX (cells as text, formula-like cells counted but never rewritten), images, Markdown with raw HTML disabled, text/JSON heads, and HTML/Plotly/PDF in a frame shown only after **Show preview** that grants scripts and nothing else, over bytes served with a deny-by-default CSP — a browser guarantee only, since the script ran unisolated. **Download all** streams a store-only ZIP. A run with nothing, or less than promised, shows a headline, detail, and next steps wired to real controls. Seven read-only endpoints serve lists, bytes, pages, previews, and archives with `nosniff` and an SHA-256 ETag; outputs live for the life of the task and are deleted with it, never by age.

---

## Verification & Execution

**FEAT-108 — Locked Python Runtime Execution** _(updated: 2026-09-25 by implement)_
Source spec: [spec.md](features/FEAT-108-python_runtime_execution/spec.md)

Auto-Mate ships two committed uv environments and pins CPython 3.14.6. It prepares them in the background or when requested, records resolved packages and a runtime fingerprint, exposes readiness through the local API and Settings, and retries failed preparations. A run awaits readiness before its approval gate, then uses a digest-checked launcher and the existing three-method `PythonRunner` seam. Script runs record the lock digest, output bytes, and any limit breach. Wall-clock and output caps apply on every platform; macOS/Linux also set hard address-space and file-size limits. Windows has no memory cap. These measures prevent dependency drift and bound some resource use; generated code still has this application's file and network access. The opt-in live suite exercises real uv and Python, and CI is configured for Windows, macOS, and Linux.

**FEAT-107 — Independent Verification & Execution Gate** _(updated: 2026-09-25 by implement)_
Source spec: [spec.md](features/FEAT-107-verification_execution_gate/spec.md)

A finalized script hands off from generation to `verifying`. The app then runs seven checks itself, with no model call:
- integrity of the sealed files and reproducible test data;
- the entrypoint, the declared outputs, and the required input columns against the file's profile;
- `ruff --isolated` and `bandit` with an app-owned config and ini, run from `~/.automate/verify-env/`;
- the tests, re-run against rebuilt synthetic data.

Failing tests, bandit HIGH/HIGH, ruff `E9`/`F6`/`F7`/`F82`/`invalid-syntax`, missing columns, failed contract or integrity checks, and any check that could not run all block, and the run settles `failed` with a readable verdict. Everything else is advisory. Results bind to the code digest and a runtime fingerprint, so a runtime change forces re-checking.

A passing run parks at `awaiting_approval`. The gate shows reads, writes, checks, the runtime, and three fixed caveats, and runs only on **Run it**. The approval binds to the code, the runtime, and the displayed intent's digest; `openGated` re-compares them before anything spawns. The script runs against a verified copy of the file in `runs/{id}/input/`. Exit 0 with a complete manifest parks at `awaiting_review`: accepting completes the run, and rejecting stores the feedback and starts a linked `feedback` retry. Both gates survive a restart and hold no concurrency slot. Six endpoints under `/api/executions/:id/…` serve the flow, and the existing abort cancels every leg. The input copy and checker setup are hygiene, not isolation.

---

## Data Ingestion & Disclosure

**FEAT-104 — CSV/XLSX Ingestion & Profiling** _(updated: 2026-09-24 by implement)_
Source spec: [spec.md](features/FEAT-104-csv_xlsx_ingestion_profiling/spec.md)

People attach up to five `.csv`/`.tsv`/`.xlsx` files (50 MB each) through `POST /api/uploads`. Each file is streamed to disk under a mid-stream size cap, format-sniffed from its content (legacy `.xls` is refused with re-save guidance), and profiled locally in Node in one bounded-memory pass. The profile covers encoding, delimiter, and header detection; per-column types with day/month versus month/day ambiguity flagged, never guessed; statistics; the first 10 rows; and structured findings. The only representation that may ever leave the machine is a deterministic disclosure payload capped at 64 KiB: 10 sample rows with 200-character cells, and frequent values only for columns under 1,000 distinct values, degraded in a fixed, recorded order. Nothing is transmitted by this feature. `POST /api/tasks` with `uploadIds` claims analyzed uploads in the task's own transaction. Files are kept byte-for-byte for the life of the task, and unattached uploads are swept after `AUTOMATE_STAGED_UPLOAD_TTL_HOURS`.

**FEAT-105 — Disclosure Review & Clarification Behavior** _(updated: 2026-09-25 by implement)_
Source spec: [spec.md](features/FEAT-105-disclosure_clarification/spec.md)

Attachment tasks now stop at a disclosure review showing the literal bounded file description, recipient provider/model, required ambiguity decisions, applied defaults, and a separate diagnostics choice. Consent is pinned to the exact payload digest and recipient, verified again before transmission, and recorded with durable context or filtered-diagnostic receipts. Default-deny diagnostic filtering drops unknown output and masks user literals. The agent can ask up to three persisted meaning/data-loss questions through `request_clarification`; accepted questions park the execution without consuming an active slot, answers resume it, and cancellation or restart settles the wait honestly. Conversation events render questions, answers, waiting state, and expandable exact-byte receipts as text only. This is a transmission-consent boundary, not an execution-isolation boundary.

---

## Code Generation

**FEAT-106 — Code Generation & Agent Repair Loop** _(updated: 2026-09-25 by implement)_
Source spec: [spec.md](features/FEAT-106-code_generation_repair/spec.md)

For a task with approved files, the agent writes Python and pytest tests through four application-owned tools (`write_script`, `write_test`, `run_tests`, `finalize_script`, beside `request_clarification`) and has no filesystem, shell, or network tool. Files land in the database first; each `run_tests` seals the draft into an immutable `code_version` whose SHA-256 digest covers its file set, projects it to `scripts/{executionId}/attempt-{n}/`, and runs pytest against synthetic fixtures built from the approved disclosure payload — the real upload is never opened. Attempts are capped by `AUTOMATE_MAX_GENERATION_ATTEMPTS` (default 3) counted in the database; wall clock (`AUTOMATE_GENERATION_TIMEOUT_MS`, 10 min) and an off-by-default spend cap also apply, and a refusal is recorded and rendered, never thrown. Test output reaches the model only through FEAT-105's default-deny diagnostic filter as a recorded `diagnostics` transmission; without that consent scope the loop refuses instead of repairing. A run settles `completed` with a final version (tests passing or not — FEAT-107 judges), or `failed`/`aborted` with a plain-English reason; a failed run offers a guidance retry that starts a new linked execution reusing the consent and prior pre-flight answers.

---

## Task Execution & Conversation

**FEAT-104 — Composer File Attachment** _(updated: 2026-09-24 by implement)_
Source spec: [spec.md](features/FEAT-104-csv_xlsx_ingestion_profiling/spec.md)

The New task composer accepts dropped or chosen CSV/XLSX files. It pre-checks extension, size, and count with the server's exact messages, shows determinate upload progress and then "Analyzing…", and blocks **Start task** until every file settles. A lazily loaded preview renders each file's sheets, columns, statistics, sample rows as plain text only, and plain-English findings, stating that nothing has been sent. Failed files show the server's message with **Retry**; **Remove** deletes a staged upload. Text-only tasks work as before.

**FEAT-103 — Task Description & Conversation Surface** _(updated: 2026-09-23 by implement)_
Source spec: [spec.md](features/FEAT-103-task_conversation_surface/spec.md)

People can submit a text-only task, follow its persisted conversation live, and cancel an active provider run. REST owns commands and replay while a resumable WebSocket carries the live tail; per-execution sequence numbers prevent gaps and duplicates, and server restarts convert active runs into readable `EXECUTION_INTERRUPTED` failures. The React surface safely renders normalized user, assistant, tool, turn, state, and failure events without exposing raw provider logs or SDK types.

---

## AI Provider Integration

**FEAT-102 — Pi Provider Interface & Configuration** _(updated: 2026-09-22 by implement)_
Source spec: [spec.md](features/FEAT-102-pi_provider_interface/spec.md)

The application reaches an AI coding agent only through `AgentProvider.open(options)`, whose session exposes `run(prompt)`, `subscribe(listener)`, `abort()`, and `close()` and emits a closed five-member event union (`tool_started`, `tool_finished`, `assistant_text`, `turn_finished`, `failed`). The Pi SDK (pinned at `@earendil-works/pi-coding-agent@0.87.1`) is confined to one adapter directory by an ESLint rule and a source-text scan; built-in tools are off by default and no ambient Pi settings, extensions, skills, prompts, themes, or context files reach a session. Provider and model selection lives in `~/.automate/config/agent.json`, credentials in `~/.automate/pi/`, and session logs in `~/.automate/agent-sessions/<executionId>/`. Mid-run provider failures surface as a `failed` event with `outcome: 'failed'` rather than a rejection; startup problems are typed `AGENT_*` errors and never a degraded client.

**FEAT-102 — Agent Settings Page & API** _(updated: 2026-09-22 by implement)_
Source spec: [spec.md](features/FEAT-102-pi_provider_interface/spec.md)

`/settings` lists every provider with its credential status and source, filters models to the selected provider, saves the selection through `PUT /api/agent/config`, and runs **Test connection**, which opens one real session, calls a single `status` tool, and reports the event counts or a plain-English typed error. `GET /api/agent/config`, `GET /api/agent/providers`, and `POST /api/agent/test-connection` complete the surface; none returns a credential value and the page offers no field to type one. A key is supplied through the provider's environment variable, the Pi CLI login, or an opt-in to an existing personal Pi `auth.json` that changes the credential path and nothing else. `pnpm doctor --agent-smoke` performs the same round trip from a terminal, exiting non-zero with `AGENT_AUTH_UNAVAILABLE` or `AGENT_MODEL_NOT_FOUND` rather than hanging. Every payload crossing out of the SDK passes a four-pass sanitizer whose exact-match scrub is the only hard guarantee.

---

## Application Foundation

**FEAT-101 — Project Bootstrap & Application Shell** _(updated: 2026-09-21 by implement)_
Source spec: [spec.md](features/FEAT-101-project_bootstrap/spec.md)

Developers can install the pinned workspace, run `pnpm doctor`, and start the local server and browser shell together with `pnpm dev`. The shell provides New task, History, and Settings navigation, a persistent light/dark theme choice, and a live connected, degraded, or unreachable server status. Startup prepares the configured data directory and SQLite metadata migration; `GET /api/health` reports version, uptime, database status, schema version, and data root. API errors use one correlation-ID envelope, and the server listens on loopback by default. This developer preview has no task execution and no enforced isolation boundary.
