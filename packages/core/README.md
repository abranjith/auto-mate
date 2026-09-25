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

## Disclosure and clarification

`packages/core/src/disclosure/` is the browser-safe policy boundary. `renderDisclosureText` is the single deterministic rendering authority for the bytes a person reviews and the bytes a provider receives. `canonicalStringify` supports stable digests; `evaluateConsent` explains digest, recipient, scope, and revocation mismatches; `classifyFindings` turns profile facts into at most three required decisions plus disclosed defaults; and `filterDiagnostics` is a default-deny allowlist that drops unrecognized output and masks literals.

`assemblePromptContext` is the single chokepoint for strings entering a provider prompt. Its only source kinds are the person's request, an approved disclosure snapshot, filtered diagnostics covered by consent, and application-authored context. Adding another source is a disclosure-policy change.

Shared TypeBox contracts cover previews, consents, receipts, clarification batches and answers, and the task-creation acknowledgement. The provider seam accepts SDK-free `AgentToolDefinition` objects; the server adapter performs provider-specific mapping.

## Ingestion

`packages/core/src/ingestion/` is the pure, browser-safe half of FEAT-104. It works over byte buffers and row iterators, with no file handles and no Node built-ins. It contains:

- `detectFileFormat`, `detectEncoding`, and `sniffCsvDialect`: content-based detection with confidences.
- `classifyCell` and `TypeTally`: type inference, including the day/month versus month/day ambiguity rule.
- `ColumnAccumulator`: Welford statistics, a SHA-256-seeded reservoir, and a value map discarded at 1,000 distinct values.
- `profileTable`: single-pass table profiling.
- `buildDisclosurePayload`: the 64 KiB bounded payload with its recorded degradation ladder.

`limits.ts` holds the D04 policy constants and the D14 provisional defaults. `contracts/upload-api.ts` holds the upload, profile, and payload schemas. `errors/ingestion-errors.ts` holds the eleven typed ingestion errors and the size and cap messages the browser reuses. See [CSV and XLSX Ingestion and Profiling](../../docs/features/csv-xlsx-ingestion.md).

## Code generation

`packages/core/src/generation/` is the browser-safe half of FEAT-106. Like the rest of this package, it has no Node built-ins.

- `computeVersionDigest(files)` is a code version's identity: SHA-256 over the canonical JSON of `[{path, sha256}]` sorted by path. It uses the synchronous, browser-safe `sha256Hex`, and a server test asserts parity with `node:crypto`. FEAT-107 binds verification to this digest.
- `validateCodePath(path, role)` is the one path rule the tool boundary and the repository share: relative, forward slashes, at most two levels, `.py`, pytest naming for tests only, and `output/` reserved.
- `buildSyntheticFixture(profile, { rowCount, seed })` builds test data from a profile or disclosed table, never from a path. Every literal in its output is either a cell of the approved disclosure payload or a value it invented. It is deterministic for a given seed. It never repeats a sample value in a high-cardinality column.
- `renderCodeContract(context)` is the only place the code-generation instructions exist. It contains no absolute path and states that test data is synthetic (`SYNTHETIC_DATA_WARNING`).
- `summarizeAttempts` and `describeAttempt` give the plain-English wording shared by the API, the transcript, and the UI. `limits.ts` holds the provisional D14 defaults.

`packages/core/src/execution/python-runner.ts` is the `PythonRunner` seam that FEAT-108 fills: `probe()`, `ensureEnvironment(signal)`, and `run(request)`, types only. A type-level test pins it at three methods. `stdout` and `stderr` in its results are raw, untrusted output, and they must pass `filterDiagnostics` before reaching any prompt.

`contracts/generation-api.ts` holds the REST shapes and the four tools' parameter schemas. `errors/generation-errors.ts` holds the eleven typed generation errors. `conversation-event.ts` adds `code_version_sealed`, `test_run_finished`, and `generation_settled`, none of which carries code or diagnostic text. `AgentToolDefinition.redactArgsInEvents` names tool arguments the transcript replaces with their size. See [Code Generation and Repair](../../docs/features/code-generation-repair.md).
