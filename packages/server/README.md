# @automate/server

The local Express API, environment preflight, and embedded SQLite storage for the developer preview.

From the repository root, run `pnpm install`, `pnpm doctor`, then `pnpm --filter @automate/server dev`. The server listens on `127.0.0.1:4317` by default. `AUTOMATE_HOST`, `AUTOMATE_PORT`, `AUTOMATE_HOME`, and `LOG_LEVEL` are optional overrides.

`GET /api/health` reports server and database status. Errors use `{ "error": { "code", "message", "correlationId" } }`. `AppMetaRepository` owns access to `app_meta`; migrations are generated offline with `pnpm db:generate` and applied automatically on startup. Storage defaults to `~/.automate/`.

Use `pnpm --filter @automate/server test` and `pnpm --filter @automate/server typecheck` during development. Tests use temporary databases.

## Agent provider

`src/agent/index.ts` is the **only** agent module the rest of the server imports. It exposes `createAgentProvider(deps)`, the `AgentConfigStore`, `probeProviders`, `runAgentSmoke`, and the in-memory `FakeAgentProvider` that later features' tests build on.

`@earendil-works/pi-coding-agent` (pinned exactly at `0.87.1`) may be imported **only** under `src/agent/adapters/pi/`. An ESLint `no-restricted-imports` rule and the source-text scan in `src/__tests__/agent-boundary.test.ts` both enforce that; a deliberate-violation fixture exists so each guard can be proven to fail.

The adapter builds its Pi environment against pinned paths under the application data root, with `allowModelNetwork: false`, in-memory settings, and a resource loader that yields zero extensions, skills, prompt templates, themes, and context files. `enumerate()` is the assertable evidence for that claim.

Agent endpoints: `GET`/`PUT /api/agent/config`, `GET /api/agent/providers`, and `POST /api/agent/test-connection`. None of them returns a credential value. `pnpm --filter @automate/server doctor --agent-smoke` opens one real session end to end.

See [AI provider configuration](../../docs/features/provider-configuration.md) for the full reference.
