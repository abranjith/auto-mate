// ---------------------------------------------------------------------------
// The minimal uv-backed Python runner (FEAT-106 TASK-004).
//
// THIS IS THE FILE FEAT-108 REPLACES. It implements the `PythonRunner` seam
// just far enough to run the agent's pytest tests in an attempt directory:
// one shared uv project at `~/.automate/env/`, prepared once per process and
// serialized, then `uv run --no-sync --locked` per test run.
//
// What `--no-sync --locked` means, stated exactly because it is easy to state
// wrongly: it prevents DEPENDENCY DRIFT — a test run cannot change which
// packages are installed. It is NOT a network restriction and NOT a sandbox.
// The generated code under test runs unisolated (D03), with this server
// process's privileges, and can reach any file or host the server can. The
// environment variables below are hygiene, not a security boundary.
//
// Process output is RAW and UNTRUSTED and is never logged here.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  PythonRuntimeUnavailableError,
  UV_SYNC_TIMEOUT_MS,
  formatDurationMs,
  type PythonRunRequest,
  type PythonRunResult,
  type PythonRunner,
  type PythonRuntimeInfo,
} from '@automate/core';
import { uvInstallHint } from '../preflight/doctor';
import { GENERATION_DEPENDENCY_SET, renderPyproject } from './python-dependency-set';
import { ProcessRunner, type ProcessResult } from './process-runner';

/** The command that installs a qualifying interpreter once uv is present. */
export const PYTHON_INSTALL_HINT = 'uv python install 3.12';
const PROBE_TIMEOUT_MS = 15_000;
/** Server variables a child never needs: this application's own settings and anything shaped like a credential. */
const WITHHELD_ENV = /^(?:AUTOMATE_.*|VIRTUAL_ENV|.*(?:API_KEY|_TOKEN|_SECRET|PASSWORD|CREDENTIALS?))$/i;

export interface UvPythonRunnerOptions {
  readonly envDir: string;
  readonly processes?: ProcessRunner;
  readonly platform?: NodeJS.Platform;
  readonly dependencies?: readonly string[];
  readonly uvSyncTimeoutMs?: number;
  readonly baseEnv?: NodeJS.ProcessEnv;
}

/** Map a finished process to the seam's outcome. pytest: 0 passed, 1 failed, 2–5 could not run properly. */
export function outcomeOf(result: ProcessResult): PythonRunResult['outcome'] {
  if (result.aborted) return 'aborted';
  if (result.timedOut) return 'timed_out';
  if (result.exitCode === 0) return 'passed';
  return result.exitCode === 1 ? 'failed' : 'errored';
}

/** `MinimalUvPythonRunner implements PythonRunner` — placeholder behind the seam until FEAT-108. */
export class MinimalUvPythonRunner implements PythonRunner {
  private readonly processes: ProcessRunner;
  private readonly platform: NodeJS.Platform;
  private readonly dependencies: readonly string[];
  private prepared: string | null = null;
  private inflight: Promise<void> | null = null;

  constructor(private readonly options: UvPythonRunnerOptions) {
    this.processes = options.processes ?? new ProcessRunner({ platform: options.platform });
    this.platform = options.platform ?? process.platform;
    this.dependencies = options.dependencies ?? GENERATION_DEPENDENCY_SET;
  }

  /** Report uv and a qualifying Python. @returns Versions only — never an interpreter path. @throws PythonRuntimeUnavailableError naming the missing tool and its install command. */
  async probe(): Promise<PythonRuntimeInfo> {
    const uv = await this.uv(['--version'], PROBE_TIMEOUT_MS);
    if (uv.spawnError || uv.exitCode !== 0) throw new PythonRuntimeUnavailableError('uv', uvInstallHint(this.platform));
    const listed = await this.uv(['python', 'list', '--only-installed'], PROBE_TIMEOUT_MS);
    const version = /cpython-(3\.(?:1[1-9]|[2-9]\d)\.\d+)/.exec(listed.exitCode === 0 ? listed.stdout : '')?.[1];
    if (!version) throw new PythonRuntimeUnavailableError('Python', PYTHON_INSTALL_HINT);
    return { uvVersion: uv.stdout.split(/\r?\n/)[0]!.trim(), pythonVersion: version };
  }

  /** Prepare `env/` once per process; concurrent callers share one preparation. @param signal Cancels preparation. @throws PythonRuntimeUnavailableError when uv cannot lock or sync. */
  async ensureEnvironment(signal: AbortSignal): Promise<void> {
    const content = renderPyproject(this.dependencies);
    while (this.prepared !== content) {
      if (!this.inflight) {
        this.inflight = this.prepare(content, signal).finally(() => { this.inflight = null; });
        return this.inflight;
      }
      // Another caller is preparing; wait for it, then re-check. If it failed,
      // this caller retries under its own signal and surfaces its own error.
      await this.inflight.catch(() => undefined);
    }
  }

  /** Run Python in the prepared environment. @param request Application-built invocation. @returns Outcome plus raw, untrusted, bounded output. */
  async run(request: PythonRunRequest): Promise<PythonRunResult> {
    const result = await this.processes.run({
      command: 'uv',
      args: ['run', '--project', this.options.envDir, '--no-sync', '--locked', '--', 'python', ...request.args],
      cwd: request.workingDir,
      env: this.childEnv(request.env),
      timeoutMs: request.timeoutMs,
      signal: request.signal,
    });
    return { outcome: outcomeOf(result), exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, droppedBytes: result.droppedBytes, durationMs: result.durationMs };
  }

  /** Write the project if it changed (dropping a stale lock), lock when no lock exists, then sync exactly. */
  private async prepare(content: string, signal: AbortSignal): Promise<void> {
    const envDir = this.options.envDir;
    mkdirSync(envDir, { recursive: true });
    const pyproject = path.join(envDir, 'pyproject.toml');
    const lock = path.join(envDir, 'uv.lock');
    if (!existsSync(pyproject) || readFileSync(pyproject, 'utf8') !== content) {
      writeFileSync(pyproject, content);
      // `--locked` refuses a lock that no longer matches the project, so a changed set needs a fresh one.
      rmSync(lock, { force: true });
    }
    if (!existsSync(lock)) this.assertPrepared(await this.uv(['lock', '--project', envDir], this.syncTimeout(), signal), 'lock');
    this.assertPrepared(await this.uv(['sync', '--locked', '--project', envDir], this.syncTimeout(), signal), 'sync');
    this.prepared = content;
  }

  private assertPrepared(result: ProcessResult, step: 'lock' | 'sync'): void {
    if (result.spawnError) throw new PythonRuntimeUnavailableError('uv', uvInstallHint(this.platform));
    if (result.aborted) throw new PythonRuntimeUnavailableError('uv', uvInstallHint(this.platform), 'Preparing the Python environment was cancelled.');
    if (result.timedOut) throw new PythonRuntimeUnavailableError('uv', uvInstallHint(this.platform), `Preparing the Python environment took longer than ${formatDurationMs(this.syncTimeout())} and was stopped. The first setup downloads packages; check the network connection and try again.`);
    if (result.exitCode !== 0) throw new PythonRuntimeUnavailableError('uv', uvInstallHint(this.platform), `The Python environment for testing could not be prepared (uv ${step} exited with code ${result.exitCode ?? 'unknown'}). The first setup downloads packages; check the network connection and try again.`);
  }

  private syncTimeout(): number { return this.options.uvSyncTimeoutMs ?? UV_SYNC_TIMEOUT_MS; }

  private uv(args: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<ProcessResult> {
    return this.processes.run({ command: 'uv', args, env: this.childEnv({}), timeoutMs, ...(signal ? { signal } : {}) });
  }

  /** The inherited environment minus this application's settings and credential-shaped variables, plus UTF-8 I/O. Hygiene, not isolation. */
  private childEnv(extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
    const base = this.options.baseEnv ?? process.env;
    const kept = Object.fromEntries(Object.entries(base).filter(([name]) => !WITHHELD_ENV.test(name)));
    return { ...kept, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', ...extra };
  }
}
