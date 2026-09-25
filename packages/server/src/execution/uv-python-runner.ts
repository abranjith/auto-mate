// Locked uv execution prevents dependency drift. It does not restrict a
// script's network or file access. The absolute launcher path and
// PYTHONSAFEPATH stop accidental launcher substitution, not hostile code.
import path from 'node:path';
import { NonPythonEntrypointError, RuntimeNotPreparedError, SCRIPT_MAX_OUTPUT_FILE_BYTES, SCRIPT_MAX_OUTPUT_TOTAL_BYTES, SCRIPT_MAX_OUTPUT_FILES, SCRIPT_MEMORY_LIMIT_BYTES, describeLimitBreach, type PythonRunRequest, type PythonRunResult, type PythonRunner, type PythonRuntimeInfo } from '@automate/core';
import { LOCKED_COMMANDS, PINNED_PYTHON_VERSION, uvCommand } from './dependency-policy';
import { verifyLauncher } from './launcher-deploy';
import { ProcessRunner, type ProcessResult } from './process-runner';
import type { RuntimeProvisioner } from './runtime-provisioner';

export const PYTHON_INSTALL_HINT = `uv python install ${PINNED_PYTHON_VERSION}`;

/** Server variables and credential-shaped values withheld from generated code. Hygiene, not isolation. */
export const WITHHELD_ENV = /^(?:AUTOMATE_.*|VIRTUAL_ENV|.*(?:API_KEY|_TOKEN|_SECRET|PASSWORD|CREDENTIALS?))$/i;

export interface UvPythonRunnerOptions {
  readonly envDir: string;
  readonly provisioner: Pick<RuntimeProvisioner, 'ensureRuntime' | 'getReadiness' | 'probeUv' | 'getLauncherDigest'>;
  readonly processes?: ProcessRunner;
  readonly platform?: NodeJS.Platform;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly memoryLimitBytes?: number;
  readonly maxOutputFileBytes?: number;
  readonly maxOutputTotalBytes?: number;
  readonly maxOutputFiles?: number;
  readonly outputWatchIntervalMs?: number;
}

/** Map pytest and script exit codes into the unchanged PythonRunner result seam. */
export function outcomeOf(result: ProcessResult): PythonRunResult['outcome'] {
  if (result.aborted) return 'aborted';
  if (result.timedOut) return 'timed_out';
  if (result.exitCode === 0) return 'passed';
  if (result.exitCode === 1 || result.exitCode === 93 || result.exitCode === 94) return 'failed';
  return 'errored';
}

/** Runs generated tests and approved Python scripts in a committed, locked uv project. */
export class UvPythonRunner implements PythonRunner {
  private readonly processes: ProcessRunner;

  constructor(private readonly options: UvPythonRunnerOptions) {
    this.processes = options.processes ?? new ProcessRunner({ platform: options.platform });
  }

  /** Report pinned Python and the observed uv version. */
  async probe(): Promise<PythonRuntimeInfo> {
    const ready = this.options.provisioner.getReadiness('script').environment;
    if (ready?.status === 'ready') return { uvVersion: ready.uvVersion, pythonVersion: ready.pythonVersion };
    return { uvVersion: await this.options.provisioner.probeUv(), pythonVersion: PINNED_PYTHON_VERSION };
  }

  /** Prepare the shared script environment, serialized by RuntimeProvisioner. */
  async ensureEnvironment(signal: AbortSignal): Promise<void> {
    await this.options.provisioner.ensureRuntime('script', signal);
  }

  /** Run one application-selected Python invocation with bounded output and tree cancellation. */
  async run(request: PythonRunRequest): Promise<PythonRunResult> {
    const result = await this.processes.run({
      command: uvCommand(this.platform()), args: this.arguments(request.args),
      cwd: request.workingDir, env: this.childEnv(request.env), timeoutMs: request.timeoutMs, signal: request.signal,
      ...(request.args[0]?.endsWith('.py') && request.env.AUTOMATE_OUTPUT_DIR ? { outputWatch: { dir: request.env.AUTOMATE_OUTPUT_DIR, limits: { maxFileBytes: this.options.maxOutputFileBytes ?? SCRIPT_MAX_OUTPUT_FILE_BYTES, maxTotalBytes: this.options.maxOutputTotalBytes ?? SCRIPT_MAX_OUTPUT_TOTAL_BYTES, maxFiles: this.options.maxOutputFiles ?? SCRIPT_MAX_OUTPUT_FILES, ...(this.options.outputWatchIntervalMs ? { intervalMs: this.options.outputWatchIntervalMs } : {}) } } } : {}),
    });
    const stderr = result.limitBreached && result.limitBreached !== 'time' ? describeLimitBreach(result.limitBreached) : result.exitCode === 93 ? describeLimitBreach('memory') : result.exitCode === 94 ? describeLimitBreach('output_bytes') : result.stderr;
    return { outcome: outcomeOf(result), exitCode: result.exitCode, stdout: result.stdout, stderr, droppedBytes: result.droppedBytes, durationMs: result.durationMs };
  }

  private arguments(args: readonly string[]): readonly string[] {
    if (args[0] === '-m' && args[1] === 'pytest') return [...LOCKED_COMMANDS.runTests(this.options.envDir), ...args.slice(3)];
    if (args[0] === '-c' && args[1]) return LOCKED_COMMANDS.inspect(this.options.envDir, args[1]);
    const entrypoint = args[0];
    if (!entrypoint || path.extname(entrypoint).toLowerCase() !== '.py') throw new NonPythonEntrypointError();
    const readiness = this.options.provisioner.getReadiness('script');
    if (!readiness.ready) throw new RuntimeNotPreparedError('script');
    const launcher = verifyLauncher(this.options.envDir, this.options.provisioner.getLauncherDigest());
    return LOCKED_COMMANDS.runScript(this.options.envDir, launcher, entrypoint);
  }

  private childEnv(extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
    const base = this.options.baseEnv ?? process.env;
    return { ...Object.fromEntries(Object.entries(base).filter(([name]) => !WITHHELD_ENV.test(name))), PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONSAFEPATH: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1', AUTOMATE_MEMORY_LIMIT_BYTES: String(this.options.memoryLimitBytes ?? SCRIPT_MEMORY_LIMIT_BYTES), AUTOMATE_MAX_OUTPUT_FILE_BYTES: String(this.options.maxOutputFileBytes ?? SCRIPT_MAX_OUTPUT_FILE_BYTES), ...extra };
  }

  private platform(): NodeJS.Platform { return this.options.platform ?? process.platform; }
}
