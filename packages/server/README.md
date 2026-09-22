# @automate/server

The local Express API, environment preflight, and embedded SQLite storage for the developer preview.

From the repository root, run `pnpm install`, `pnpm doctor`, then `pnpm --filter @automate/server dev`. The server listens on `127.0.0.1:4317` by default. `AUTOMATE_HOST`, `AUTOMATE_PORT`, `AUTOMATE_HOME`, and `LOG_LEVEL` are optional overrides.

`GET /api/health` reports server and database status. Errors use `{ "error": { "code", "message", "correlationId" } }`. `AppMetaRepository` owns access to `app_meta`; migrations are generated offline with `pnpm db:generate` and applied automatically on startup. Storage defaults to `~/.automate/`.

Use `pnpm --filter @automate/server test` and `pnpm --filter @automate/server typecheck` during development. Tests use temporary databases.
