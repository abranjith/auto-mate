# @automate/web

The React application shell for the Auto-Mate developer preview. It has New task, History, and Settings placeholders, a theme switch, and live server status.

From the repository root, run `pnpm install` then `pnpm --filter @automate/web dev`. The development server listens on `127.0.0.1:5173` and proxies `/api` to the local server on port 4317. Run `pnpm --filter @automate/web build`, `pnpm --filter @automate/web test`, and `pnpm --filter @automate/web typecheck` to verify it.

Components use semantic classes from `src/design-system/tokens.ts`. Routes live under `src/routes/`; the TanStack Router plugin regenerates `src/routeTree.gen.ts` during build and development. `src/api/api-client.ts` validates the shared health contract and decodes the server error envelope.
