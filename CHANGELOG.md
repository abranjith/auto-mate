# Changelog

## Unreleased — FEAT-108 Locked Python runtime execution

- Added committed script and checker `uv.lock` manifests, exact CPython 3.14.6 provisioning, persisted runtime readiness, background preparation, runtime status and prepare endpoints, and a Settings status panel. Script packages: pandas 3.0.6, openpyxl 3.1.5, xlsxwriter 3.2.9, plotly 7.1.0, matplotlib 3.11.2, jinja2 3.1.6, python-dateutil 2.9.0.post0, pytest 9.1.1. Checkers: ruff 0.16.9 and bandit 1.9.4.
- Replaced the minimal runner with locked execution and an app-owned launcher. Added process-tree timeout and cancellation, captured-output and produced-output caps on all platforms, plus hard memory and file-size limits on macOS and Linux. Windows has no memory limit. Limit breaches are recorded on script runs and shown in the UI.
- Added a real uv and Python suite gated by `AUTOMATE_LIVE_PYTHON=1`, with a three-platform CI matrix. Locked dependencies prevent drift, not access to files or the network; generated code still runs with this application's access to the computer.

## Unreleased — FEAT-107 Independent verification and execution gate

- A finalized script is now checked by the application itself before it can run, in this order:
  - integrity of the sealed files and the reproducibility of their test data;
  - the entry point, the declared outputs, and the input columns the script needs;
  - `ruff` and `bandit`;
  - the script's tests, re-run by the app against rebuilt synthetic data.

  Failing tests, bandit HIGH/HIGH, ruff error-class rules (including `invalid-syntax`), missing columns, and any check that could not run all block. Everything else is shown as advisory. No model is called.
- Results are bound to the exact code digest and a fingerprint of the runtime (Python, uv, platform, and every package). A changed runtime is checked again, and the gate names what changed.
- Added the approval gate. It shows what will be read and written, the check results, the runtime, and three caveats. It runs only on an explicit **Run it**. The approval binds to the code, the runtime, and the digest of what was shown, and a stale page is refused.
- Added a minimal real-data run behind the existing `PythonRunner` seam, against a verified copy of the file in `runs/{executionId}/input/`. Exit 0 with a valid manifest now parks at **Did this do what you wanted?**. Rejecting stores the feedback and starts a new linked run (`trigger = 'feedback'`).
- New statuses `awaiting_approval`, `awaiting_review`, and `rejected`. Both gates survive a restart and free the concurrency slot. The existing abort covers checking, both gates, and the run.
- Added the `verification_run`, `verification_check`, `verification_finding`, `execution_approval`, and `script_run` tables. Also added six endpoints, four transcript events, eleven error codes, six provisional limits, and the `verify-env/` checker environment (ruff 0.16.8, bandit 1.9.4), run with `--isolated` and an app-owned `-c`/`--ini`.
- Fixed: migrations that rebuild a table with dependents no longer cascade-delete child rows (foreign keys are now off around the migrator). The migration also ends with a foreign-key check.
- Fixed: XLSX synthetic fixtures are now byte-reproducible. They previously embedded the time they were written.
- The copied input, `verify-env`, and `--isolated` are hygiene, not a security boundary. Generated code still runs without isolation and can reach other files on this computer.

## Unreleased — FEAT-106 Code generation and agent repair loop

- For tasks with approved files, the agent now writes a Python script and its own pytest tests, runs them, reads filtered failures, and repairs. It works only through four application-owned tools: `write_script`, `write_test`, `run_tests`, and `finalize_script`. It still has no file, shell, or network tool of its own.
- Tests run against synthetic data built from the approved file description: the approved sample rows plus rows invented from the recorded statistics. The real file is not opened during generation.
- Each attempt is sealed as an immutable code version identified by a SHA-256 over its files. Files are written to disk from the database, never from the agent's arguments.
- Added provisional limits: `AUTOMATE_MAX_GENERATION_ATTEMPTS` (3, counted in the database) and a 10-minute wall clock that pauses while a run waits for an answer. The optional spend cap is off by default. Per-test-run, environment-preparation, fixture-size, and file-size limits are also configurable. A refusal is recorded and shown, never thrown.
- Test output reaches the model only through the default-deny diagnostic filter, as a recorded transmission. If failure details were not approved, the loop stops instead of repairing.
- Added the transcript's attempt cards, test results with a withheld-line count, the synthetic-data note, a progress line, and a "Tell me what I got wrong" retry. The retry starts a new linked run that reuses the approval and earlier answers.
- Added the `code_version`, `code_file`, `generation_attempt`, and `synthetic_fixture` tables and the `execution` retry columns. Added five generation endpoints and eleven error codes.
- Added a minimal `uv`-backed runner behind the `PythonRunner` seam, with process-tree cancellation. It uses a provisional package set (`pandas`, `openpyxl`, `plotly`, `pytest`) pending D05. Generated code still runs without an isolation boundary, and `--no-sync --locked` prevents dependency drift only.

## Unreleased — FEAT-105 Disclosure review and clarification behavior

- Added a blocking review that shows the literal bounded file description, provider, model, required decisions, applied defaults, and an explicit diagnostics scope before any file-derived context can reach a provider.
- Pinned approvals to exact bytes, uploads, provider, model, and scopes; stale or revoked approvals stop before the provider opens. Added append-only context and diagnostic transmission receipts.
- Added a default-deny diagnostic filter, deterministic disclosure rendering, and `assemblePromptContext` as the single prompt-construction chokepoint.
- Added pre-flight ambiguity classification and the `request_clarification` tool with a server-enforced three-question cap, a separate waiting-cap fallback, durable answers, and restart recovery.
- Added the `waiting` execution flow, slot release while a person answers, transcript question cards, cancellation, and expandable disclosure receipts.
- Added the consent, transmission, clarification, and clarification-question tables; preview, consent, receipt, clarification replay, and answer endpoints; four provisional environment limits; and nine stable error codes.

## Unreleased — FEAT-104 CSV/XLSX ingestion and profiling

- Added CSV, TSV, and XLSX attachment to the task composer. Files are chosen or dropped, uploaded with progress, profiled on this computer, and shown in a preview with column types, statistics, 10 sample rows, and plain-English findings. Nothing is transmitted.
- Added the bounded disclosure payload, the only representation of a file the application may ever send. It holds 10 sample rows with cells cut to 200 characters, and frequent values only for columns under 1,000 distinct values. It is capped at 64 KiB, degraded in a fixed, recorded order, and deterministic for a given file.
- Added content-based format, encoding, CSV dialect, and header detection. Type inference marks day/month versus month/day dates as ambiguous rather than guessing. Profiling is single-pass and bounded-memory.
- Added a streaming XLSX reader with inflation and shared-string budgets, merged-cell and formula counting, title-row skipping, and a fix for an unzipper premature-end race that dropped `xl/workbook.xml` from data-descriptor workbooks.
- Added `upload`, `upload_profile`, and `upload_column` tables. A database constraint and the repository both refuse a high-cardinality column that carries values.
- Added `POST /api/uploads`, `GET`/`DELETE /api/uploads/:id`, `GET /api/tasks/:taskId/uploads`, and `uploadIds` on `POST /api/tasks`, which claims files in the task's own transaction.
- Added eight provisional `AUTOMATE_*` ingestion limits, the eleven `UPLOAD_*`, `PARSE_*`, and related error codes, life-of-task file retention, and an orphan sweep for unattached uploads.
- Added dependencies `csv-parse` 7.0.2, `exceljs` 4.4.0, and `busboy` 1.6.0, plus a pnpm override lifting `exceljs`'s transitive `uuid` to 14.0.2 (zero audit advisories).

## Unreleased — FEAT-103 Task description and conversation surface

- Added text-only task creation, persisted task/execution state, and a gap-free ordered conversation transcript.
- Added provider-backed task sessions with assistant-text coalescing, cancellation, a configurable concurrency cap, graceful shutdown, and honest restart interruption recovery.
- Added validated task, execution, replay, and abort REST endpoints plus an Origin/Host-guarded WebSocket snapshot and live tail with heartbeat and backpressure handling.
- Added the React task composer, safe Markdown and tool-event rendering, reconnecting live stream, execution status, cancellation controls, and readable terminal failures.
- Recorded the D09 decision to use an application-owned React conversation surface instead of `@earendil-works/pi-web-ui`.

## Unreleased — FEAT-102 Pi provider interface and configuration

- Added `AgentProvider.open(options)`, an SDK-independent seam whose sessions expose only `run`, `subscribe`, `abort`, and `close`, over a closed five-member event union.
- Added the Pi adapter on `ModelRuntime`, pinned to `@earendil-works/pi-coding-agent@0.87.1`, with built-in tools disabled and no ambient Pi extensions, skills, prompts, themes, or context files.
- Added application-owned agent configuration at `~/.automate/config/agent.json`, a managed credential store under `~/.automate/pi/`, session logs under `~/.automate/agent-sessions/`, and an opt-in to an existing personal Pi credential file that changes the credential path only.
- Added a four-pass boundary sanitizer for every payload crossing outward from the SDK, and typed `AGENT_*` startup errors that never expose key material or host paths.
- Added the agent settings API, the `/settings` page with model selection, credential status, and a live **Test connection**, and `pnpm doctor --agent-smoke`.
- Added lint and test enforcement confining the Pi SDK to `packages/server/src/agent/adapters/pi/`.

## 0.1.0 — FEAT-101 Project bootstrap and application shell

- Added the pinned pnpm/TypeScript workspace with core, server, and web packages.
- Added startup preflight, local SQLite migrations, the health API, and structured error handling.
- Added a React shell with semantic design tokens, theme switching, navigation, and server status.
