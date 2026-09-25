# @automate/web

The React application for the Auto-Mate developer preview. It has a New task composer with CSV/XLSX attachment, local profile preview, blocking disclosure review, a durable clarification-aware conversation page, a History placeholder, provider Settings, theme switching, and live server status.

From the repository root, run `pnpm install` then `pnpm --filter @automate/web dev`. The development server listens on `127.0.0.1:5173` and proxies `/api` to the local server on port 4317. Run `pnpm --filter @automate/web build`, `pnpm --filter @automate/web test`, and `pnpm --filter @automate/web typecheck` to verify it.

Components use semantic classes from `src/design-system/tokens.ts`. Routes live under `src/routes/`; the TanStack Router plugin regenerates `src/routeTree.gen.ts` during build and development. `src/api/api-client.ts` validates the shared health contract and decodes the server error envelope.

`src/routes/settings.tsx` and `src/components/settings/` provide provider and model selection, per-provider credential status with remediation text, and a live **Test connection**. The page never renders a credential value and offers no field to type one; `src/api/agent-queries.ts` holds the TanStack Query hooks over the shared agent contracts. Tests live under `src/__tests__/`, mirroring the source tree, rather than beside their routes/components.

`src/components/conversation/` renders the seven normalized conversation event kinds, status, cancellation, connection health, and safe failure details. Assistant output uses `react-markdown` with raw HTML disabled; tool payloads render as text. `src/api/use-execution-stream.ts` loads durable REST history before opening the WebSocket tail, deduplicates by sequence number, reloads on gaps, and reconnects with backoff.

`src/components/ingestion/` holds the composer's file attachment:

- `file-drop-zone.tsx`: a labelled file input and drop surface. Client-side pre-checks use the server's own messages from `@automate/core`.
- `use-attachments.ts`: per-file upload state.
- `upload-list.tsx` and `upload-progress.tsx`: determinate transfer progress, then an indeterminate "analyzing" state.
- The lazily loaded `profile-panel.tsx`, with `sheet-tabs.tsx`, `column-table.tsx`, `sample-rows-table.tsx`, and `profile-notes.tsx`.

`src/api/upload-mutations.ts` uploads with XMLHttpRequest, because `fetch` cannot report upload progress. Every cell from a file renders as a text node: no `dangerouslySetInnerHTML`, no Markdown, and formula-like cells are marked rather than interpreted.

See [Task Description and Conversation Surface](../../docs/features/task-conversation-surface.md) and [CSV and XLSX Ingestion and Profiling](../../docs/features/csv-xlsx-ingestion.md) for the user flows and protocol.

Before a task with attachments starts, `src/components/disclosure/` shows the literal provider-bound text, provider and model, truncation notes, required pre-flight choices with no preselection, overridable defaults, and a separate default-on choice for filtered repair diagnostics. Consent is posted before task creation; a failed or stale consent never posts the task. File content and model-written questions render as text nodes only.

The conversation surface renders clarification requests and answers in event sequence, shows a waiting banner with the existing cancel action, and expands disclosure receipts on demand. Receipt expansion fetches the exact stored approval snapshot; the compact line does not fetch or expose those bytes.

`src/components/generation/` renders a generation run: a progress line with the attempt and time budget, a collapsed card for each code version that fetches file content only when opened, and test results with the filtered failure text. When output lines were withheld, it says so in a sentence. On every attempt, the fixture note states that the tests ran on synthetic rows and that the real file has not been read. After a failed run, a panel accepts guidance and starts a retry through `POST /api/executions/:id/retry`. `src/api/generation-queries.ts` holds the fetchers. Generated code, the agent's summary, and diagnostics render as text nodes only.

After generation, `src/components/verification/gate-section.tsx` shows FEAT-107's part of a run. `verification-report.tsx` lists the seven checks with blocking or advisory badges and expandable findings grouped by file. `run-intent-panel.tsx` is the gate: what will be read and written, the check verdict, the runtime line, and the three caveats verbatim. **Run it** stays disabled until warnings are acknowledged, and a stale page is refetched. `src/components/execution/` shows the run in progress, with the honest access line, and its result. `src/components/review/review-panel.tsx` asks "Did this do what you wanted?" and takes feedback for a retry. `src/api/verification-queries.ts` holds the fetchers. Finding messages, the agent's summary, manifest text, and captured output render as text nodes only.
