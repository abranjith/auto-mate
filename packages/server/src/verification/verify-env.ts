// Checkers use the locked verify-env, never generated code's cwd or config.
// Configuration isolation for tools is hygiene; generated Python still runs
// with this application's file and network access.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LOCKED_COMMANDS, uvCommand, type CheckerTool } from '../execution/dependency-policy';
import { ProcessRunner, type ProcessResult } from '../execution/process-runner';
import type { RuntimeProvisioner } from '../execution/runtime-provisioner';
import { WITHHELD_ENV } from '../execution/uv-python-runner';

export { VERIFICATION_TOOL_SET, type CheckerTool } from '../execution/dependency-policy';
export interface VerifyEnvironmentOptions {
  readonly verifyEnvDir: string;
  readonly provisioner?: Pick<RuntimeProvisioner, 'ensureRuntime'>;
  readonly processes?: ProcessRunner;
  readonly platform?: NodeJS.Platform;
  readonly baseEnv?: NodeJS.ProcessEnv;
}
export type CheckerResult = ProcessResult;

/** Strict checker configuration controlled by the application. */
export function renderBanditConfig(): string { return '# All Bandit checks enabled.\nskips: []\n'; }
/** Explicit empty ini prevents Bandit reading a generated .bandit file. */
export function renderBanditIni(): string { return '[bandit]\n'; }

/** Owns checker configuration and delegates locked preparation to RuntimeProvisioner. */
export class VerifyEnvironment {
  private readonly processes: ProcessRunner;
  constructor(private readonly options: VerifyEnvironmentOptions) {
    this.processes = options.processes ?? new ProcessRunner({ platform: options.platform });
  }

  get banditConfigPath(): string { return path.join(this.options.verifyEnvDir, 'bandit.yaml'); }
  get banditIniPath(): string { return path.join(this.options.verifyEnvDir, 'bandit.ini'); }

  async ensureVerifyEnvironment(signal: AbortSignal): Promise<void> {
    if (!this.options.provisioner) throw new Error('Runtime provisioner is required to prepare code checkers.');
    await this.options.provisioner.ensureRuntime('verify', signal);
    mkdirSync(this.options.verifyEnvDir, { recursive: true });
    writeFileSync(this.banditConfigPath, renderBanditConfig());
    writeFileSync(this.banditIniPath, renderBanditIni());
  }

  runTool(tool: CheckerTool, args: readonly string[], timeoutMs: number, signal: AbortSignal): Promise<CheckerResult> {
    return this.processes.run({ command: uvCommand(this.options.platform ?? process.platform), args: LOCKED_COMMANDS.runChecker(this.options.verifyEnvDir, tool, args), cwd: this.options.verifyEnvDir, env: this.childEnv(), timeoutMs, signal });
  }

  async probeCheckerVersions(signal: AbortSignal = new AbortController().signal): Promise<Record<CheckerTool, string>> {
    const version = async (tool: CheckerTool) => {
      const result = await this.runTool(tool, ['--version'], 15_000, signal);
      return result.exitCode === 0 ? (/\d+\.\d+\.\d+/.exec(result.stdout)?.[0] ?? 'unknown') : 'unavailable';
    };
    return { ruff: await version('ruff'), bandit: await version('bandit') };
  }

  private childEnv(): NodeJS.ProcessEnv {
    return { ...Object.fromEntries(Object.entries(this.options.baseEnv ?? process.env).filter(([name]) => !WITHHELD_ENV.test(name))), PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONSAFEPATH: '1' };
  }
}
