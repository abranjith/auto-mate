<!-- Maintained by spec-lite | updated by: implement, fix skills -->

# Feature Summary

> Current implemented behavior only. Change history lives in source control.

## Task Execution & Conversation

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
