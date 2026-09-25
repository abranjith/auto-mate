<!-- Maintained by spec-lite | updated by: implement, fix skills -->

# Feature Summary

> Current implemented behavior only. Change history lives in source control.

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
