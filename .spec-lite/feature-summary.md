<!-- Maintained by spec-lite | updated by: implement, fix skills -->

# Feature Summary

> Current implemented behavior only. Change history lives in source control.

## Application Foundation

**FEAT-101 — Project Bootstrap & Application Shell** *(updated: 2026-09-21 by implement)*  
Source spec: [spec.md](features/FEAT-101-project_bootstrap/spec.md)

Developers can install the pinned workspace, run `pnpm doctor`, and start the local server and browser shell together with `pnpm dev`. The shell provides New task, History, and Settings placeholders, a persistent light/dark theme choice, and a live connected, degraded, or unreachable server status. Startup prepares the configured data directory and SQLite metadata migration; `GET /api/health` reports version, uptime, database status, schema version, and data root. API errors use one correlation-ID envelope, and the server listens on loopback by default. This developer preview has no task execution or isolation boundary.
