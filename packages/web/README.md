# @automate/web

The React application for the Auto-Mate developer preview. It has a text-only New task composer, a durable live conversation page, a History placeholder, provider Settings, theme switching, and live server status.

From the repository root, run `pnpm install` then `pnpm --filter @automate/web dev`. The development server listens on `127.0.0.1:5173` and proxies `/api` to the local server on port 4317. Run `pnpm --filter @automate/web build`, `pnpm --filter @automate/web test`, and `pnpm --filter @automate/web typecheck` to verify it.

Components use semantic classes from `src/design-system/tokens.ts`. Routes live under `src/routes/`; the TanStack Router plugin regenerates `src/routeTree.gen.ts` during build and development. `src/api/api-client.ts` validates the shared health contract and decodes the server error envelope.

`src/routes/settings.tsx` and `src/components/settings/` provide provider and model selection, per-provider credential status with remediation text, and a live **Test connection**. The page never renders a credential value and offers no field to type one; `src/api/agent-queries.ts` holds the TanStack Query hooks over the shared agent contracts. Route files exclude co-located `*.test.tsx` through `routeFileIgnorePattern`.

`src/components/conversation/` renders the seven normalized conversation event kinds, status, cancellation, connection health, and safe failure details. Assistant output uses `react-markdown` with raw HTML disabled; tool payloads render as text. `src/api/use-execution-stream.ts` loads durable REST history before opening the WebSocket tail, deduplicates by sequence number, reloads on gaps, and reconnects with backoff. The composer deliberately has no file or URL input; ingestion and disclosure are later features.

See [Task Description and Conversation Surface](../../docs/features/task-conversation-surface.md) for the user flow and protocol.
