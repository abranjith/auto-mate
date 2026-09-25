// ---------------------------------------------------------------------------
// The Python runner seam (FEAT-106 TASK-001). Types only.
//
// FEAT-106 ships a minimal uv-backed implementation sufficient to run pytest
// in an attempt directory. FEAT-108 REPLACES that implementation — locked
// dependency policy, resource limits, the real-data leg — without changing
// this seam, so it changes one file rather than a call graph. Widening this
// interface is a deliberate act; a type-level test pins it at three methods.
//
// UNTRUSTED OUTPUT: `PythonRunResult.stdout` and `stderr` are raw bytes from
// generated code that runs WITHOUT an isolation boundary (D03) and can read
// any file the server process can. They must pass `filterDiagnostics`
// (through FEAT-105's `recordDiagnosticTransmission`) before any byte of them
// reaches a prompt, and they are never logged.
//
// No Node built-ins: `packages/web` imports `packages/core`.
// ---------------------------------------------------------------------------

/** What `probe()` found on this host. */
export interface PythonRuntimeInfo {
  /** `uv --version` output, first line. */
  readonly uvVersion: string;
  /** The Python version uv will use, for example `3.12.7`. */
  readonly pythonVersion: string;
}

/** One Python invocation. The runner prefixes its own locked `uv run` arguments. */
export interface PythonRunRequest {
  /** The execution this run belongs to; used for cancellation bookkeeping and logs. */
  readonly executionId: number;
  /** Absolute working directory, chosen by the application, never by the model. */
  readonly workingDir: string;
  /** Arguments after `python`, for example `['-m', 'pytest', '-q']`. Built by the application. */
  readonly args: readonly string[];
  /** Extra environment variables, such as `AUTOMATE_INPUT_DIR` and `AUTOMATE_OUTPUT_DIR`. */
  readonly env: Readonly<Record<string, string>>;
  /** Wall-clock limit; the whole process tree is killed when it passes. */
  readonly timeoutMs: number;
  /** Cancels the run and kills the whole process tree. */
  readonly signal: AbortSignal;
}

/** How a run ended. pytest's exit code 0 is `passed`, 1 is `failed`, 2–5 are `errored`. */
export type PythonRunOutcome = 'passed' | 'failed' | 'errored' | 'timed_out' | 'aborted';

/** The result of one run. */
export interface PythonRunResult {
  readonly outcome: PythonRunOutcome;
  /** `null` when no exit code was observed (killed, or failed to spawn). */
  readonly exitCode: number | null;
  /** RAW, UNTRUSTED process output; see the header. Bounded by the runner. */
  readonly stdout: string;
  /** RAW, UNTRUSTED process output; see the header. Bounded by the runner. */
  readonly stderr: string;
  /** Output bytes dropped once the capture bound was reached. */
  readonly droppedBytes: number;
  readonly durationMs: number;
}

/** Runs Python for the application. FEAT-108 owns the production implementation. */
export interface PythonRunner {
  /** Report the host's uv and Python. @returns Versions found. @throws PythonRuntimeUnavailableError naming the missing tool and its install command. */
  probe(): Promise<PythonRuntimeInfo>;
  /** Prepare the shared environment once; idempotent and serialized. @param signal Cancels preparation. @returns When the environment is ready. */
  ensureEnvironment(signal: AbortSignal): Promise<void>;
  /** Run Python once. @param request Application-built invocation. @returns The outcome and raw, untrusted output. */
  run(request: PythonRunRequest): Promise<PythonRunResult>;
}
