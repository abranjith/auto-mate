# Auto-Mate — Enhancement Backlog

> Potential improvements discovered during planning. Out of scope for Phase 1 MVP.

## General

- [ ] Portable recipe export/import with versioned input contracts, approved rules/code, and runtime metadata; exclude private input data and credentials by default (discovered during: plan_critic)

- [ ] Content-Security-Policy layer on top of pi-web-ui's iframe sandboxing for artifact rendering (discovered during: planning)
- [ ] RAG (retrieval-augmented generation) with a library of proven script patterns to improve AI generation reliability (discovered during: planning)
- [ ] Pre-warmed Python environment with common data science packages (pandas, matplotlib, plotly, openpyxl) to reduce first-task cold start (discovered during: planning)
- [ ] Revisit orchestrator-driven vs agent-driven verification loop — evaluate if the app should control each verification phase (lint, test, review) as discrete steps rather than letting the agent self-drive. Trade-offs: more control/predictability vs simpler code and more resilient iteration (discovered during: planning-v2)
- [ ] Make agent clarification escalation threshold a user-configurable app setting (currently hardcoded at 5 auto-defaults before escalating to user) (discovered during: planning-v2)
- [ ] Community-maintained package allowlist with automatic CVE scanning for Python dependencies (discovered during: planning-v2)

## Performance

- [ ] Cache installed Python packages across task runs to avoid redundant pip/uv installs (discovered during: planning)
- [ ] Debounced smart detection — batch-process metadata extraction when multiple files are uploaded simultaneously (discovered during: planning)
- [ ] Evaluate `uv run --isolated` flag for additional Python execution sandboxing beyond venv isolation (discovered during: planning-v2)

## UI

- [ ] Keyboard shortcuts for common actions (new task, re-run, toggle developer mode) (discovered during: planning)
- [ ] Dashboard layout customization — draggable/rearrangeable cards for the gamified dashboard (discovered during: planning)
- [ ] Artifact comparison view — diff two versions of the same artifact side-by-side (discovered during: planning)

## Security

- [ ] Per-script network access control — allow/deny outbound network per task, not just globally (discovered during: planning)
- [ ] Audit log for all script executions with hash of generated code for forensic review (discovered during: planning)

## Resilience & Error Handling

- [ ] Graceful degradation for AI provider failures — retry with exponential backoff, clear user-facing error messages, ability to cancel stuck tasks when LLM API is down or rate-limited (discovered during: plan-review)
- [ ] WebSocket reconnection strategy — auto-reconnect, state recovery, missed-event replay from server-side event log when client disconnects mid-execution (discovered during: plan-review)
- [ ] Execution cancellation — `task:cancel` WebSocket event + `POST /api/executions/:id/cancel` endpoint to abort a running task (agent session or script execution) (discovered during: plan-review)
- [ ] Agent session timeout handling — define behavior when a clarification prompt goes unanswered for extended periods (session cleanup, memory limits, provider connection expiry) (discovered during: plan-review)
- [ ] Scheduled task catch-up execution — after server restart, detect missed scheduled runs and optionally re-execute them instead of silently skipping (discovered during: plan-review)

## Data Integrity

- [ ] Template input schema validation — when re-running reusable tasks with new files, validate that input files match expected schema (column names, compatible types) before executing the canonical script (discovered during: plan-review)
- [ ] SQLite execution log size limits — stream large stdout/stderr to log files on disk instead of storing in SQLite; store only metadata + summary in DB with a file path reference (discovered during: plan-review)
- [ ] IndexedDB ↔ SQLite sync recovery — handle split-brain between pi-web-ui chat state (IndexedDB) and server task state (SQLite) when browser storage is cleared or user switches browsers (discovered during: plan-review)
- [ ] Artifact orphan GC race condition protection — ensure garbage collector for unsaved orphan artifacts doesn't delete artifacts from in-progress executions (discovered during: plan-review)

## Security (Hardening)

- [ ] Filesystem sandboxing beyond system prompt enforcement — evaluate OS-level mechanisms (Linux namespaces, Windows job objects, or Docker micro-containers) to truly restrict script file access to input/output dirs (discovered during: plan-review)
- [ ] Plotly CDN vs bundle decision — resolve conflict between sandboxed iframe CSP blocking external requests and the plan to use Plotly.js CDN in self-contained HTML artifacts (discovered during: plan-review)
- [ ] Script contract runtime validation — post-execution check that scripts only wrote to `AUTOMATE_OUTPUT_DIR` and didn't create files elsewhere, as a defense-in-depth layer beyond prompt enforcement (discovered during: plan-review)

## DX (Developer Experience)

- [ ] CLI companion tool (`automate run "clean this csv"`) for power users who prefer terminal (discovered during: planning)
- [ ] Hot-reload for tool scripts — edit a tool's Python/shell script and see changes without server restart (discovered during: planning)
- [ ] OpenAPI spec auto-generation from TypeBox schemas for API documentation (discovered during: planning)
- [ ] "Dry run" mode — let users preview and optionally edit the generated script *before* execution, not only after, to build trust with power users (discovered during: plan-review)
