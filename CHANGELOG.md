# Changelog

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
