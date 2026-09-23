# Changelog

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
