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

## Verification

`packages/core/src/verification/` is the browser-safe half of FEAT-107.

- `decideGate(checks, findings)` in `gate-policy.ts` is the single place "may this run?" is answered. Blocking: a failed test re-run; bandit HIGH severity with HIGH confidence; ruff rules starting `E9`, `F6`, `F7`, or `F82`, or the code `invalid-syntax`; a failed integrity, entrypoint, or declared-output check; a missing input file or column; and any check that could not run. Everything else is advisory. The thresholds are provisional against open D14.
- `computeRuntimeFingerprint(detail)` and `describeRuntimeChange(before, after)` bind a result to a runtime and name what changed ("Python changed from 3.12.4 to 3.13.1").
- `evaluateApproval(approval, required)` has the same shape as FEAT-105's `evaluateConsent`. An approval covers exactly one code digest, one runtime fingerprint, and one displayed intent. `buildIntentDigest` digests the displayed `RunIntent`, and `RUN_INTENT_CAVEATS` is the only place the gate's warnings exist.
- `summarizeVerification` words the verdict for the API, the transcript, and the UI. `parseOutputManifest` never throws. `feedbackProblem` is the review-feedback rule. `limits.ts` holds the provisional defaults.

`conversation/execution-state.ts` adds `awaiting_approval`, `awaiting_review`, and `rejected`, and fills the `verifying` and `executing` rows. It exports `PARKED_STATUSES` (no concurrency slot) and `survivesRestart` (only the two gates). `contracts/verification-api.ts` holds the REST shapes, and `errors/verification-errors.ts` the eleven typed errors. See [Verification and the Execution Gate](../../docs/features/verification-execution-gate.md).

## Python runtime

`packages/core/src/execution/` holds the browser-safe FEAT-108 runtime contracts and provisional D14 limits. `runtime-environment.ts` describes stored preparation status, limit breaches, and platform capabilities. `describeRuntimeCapabilities(platform)` is the single source for the POSIX memory limit and Windows memory gap shown by the server and Settings. `contracts/runtime-api.ts` validates runtime status and preparation responses. `errors/runtime-errors.ts` adds six typed `RUNTIME_*`, `LAUNCHER_INTEGRITY`, `SCRIPT_LIMIT_EXCEEDED`, and `NON_PYTHON_ENTRYPOINT` codes. `PythonRunner` remains the same three-method seam; the server supplies its locked implementation. See [Python Runtime Execution](../../docs/features/python-runtime-execution.md).
