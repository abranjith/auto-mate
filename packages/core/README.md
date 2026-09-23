# @automate/core

Browser-safe contracts shared by the Auto-Mate server and web app. This package has no Node built-ins.

From the repository root, run `pnpm install`, then `pnpm --filter @automate/core test` or `pnpm --filter @automate/core typecheck`.

Key exports are `HealthResponseSchema`, `ApiErrorSchema`, the corresponding TypeScript types, `AutoMateError`, and the `ValidationError`, `ConfigurationError`, and `RepositoryError` subclasses. `AutoMateError.toJSON()` returns the public error envelope without private details or stack traces.

## Agent provider seam

`packages/core/src/agent/` defines the contract between Auto-Mate and any AI coding agent SDK, and holds two invariants: **no provider SDK type may be imported here**, and **no `AgentEvent` member may be added without a named consumer in a later feature**.

- `AgentProvider`, `AgentSession`, `AgentSessionOptions`, `AgentEvent`, `AgentRunResult`, `AgentUsage`, `AgentError` — the seam itself. `AgentEvent` is a closed union of `tool_started`, `tool_finished`, `assistant_text`, `turn_finished`, and `failed`; every member is JSON-serializable.
- `createSanitizer(options)` — the four-pass boundary sanitizer (`exact-match scrub`, shape-based redaction, path scrubbing, bounded truncation). Pure, browser-safe, and deterministic. **Only the exact-match scrub is a guarantee**; the shape pass is a heuristic.
- `AgentConfigSchema`, `AgentConfigUpdateSchema`, `DEFAULT_AGENT_CONFIG` — the application-owned provider selection. It never contains credential material.
- `AgentStartupError` and its subclasses `AgentModelNotFoundError`, `AgentAuthUnavailableError`, `AgentProviderUnavailableError`, `AgentSessionStartFailedError`, and `AgentConfigInvalidError`, each carrying a stable `AGENT_*` code.

See [AI provider configuration](../../docs/features/provider-configuration.md) for the full reference.
