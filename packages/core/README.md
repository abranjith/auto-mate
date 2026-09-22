# @automate/core

Browser-safe contracts shared by the Auto-Mate server and web app. This package has no Node built-ins.

From the repository root, run `pnpm install`, then `pnpm --filter @automate/core test` or `pnpm --filter @automate/core typecheck`.

Key exports are `HealthResponseSchema`, `ApiErrorSchema`, the corresponding TypeScript types, `AutoMateError`, and the `ValidationError`, `ConfigurationError`, and `RepositoryError` subclasses. `AutoMateError.toJSON()` returns the public error envelope without private details or stack traces.
