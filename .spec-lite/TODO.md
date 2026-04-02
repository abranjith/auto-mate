# Auto-Mate — Enhancement Backlog

> Potential improvements discovered during planning. Out of scope for Phase 1 MVP.

## General

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

## DX (Developer Experience)

- [ ] CLI companion tool (`automate run "clean this csv"`) for power users who prefer terminal (discovered during: planning)
- [ ] Hot-reload for tool scripts — edit a tool's Python/shell script and see changes without server restart (discovered during: planning)
- [ ] OpenAPI spec auto-generation from TypeBox schemas for API documentation (discovered during: planning)
