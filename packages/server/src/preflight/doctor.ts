import { ConfigurationError } from '@automate/core';
import { probeTool, type ProbeFn, type ProbeResult } from './tool-probe';

export interface CheckResult { name: string; ok: boolean; severity: 'fatal' | 'warning'; message: string; hint?: string }
export interface DoctorReport { ok: boolean; checks: CheckResult[] }
export interface DoctorOptions { probe?: ProbeFn; nodeVersion?: string; platform?: NodeJS.Platform }

/** Select a uv install hint. @param platform Operating system. @returns A platform-specific command. */
export function uvInstallHint(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'winget install astral-sh.uv' : 'curl -LsSf https://astral.sh/uv/install.sh | sh';
}

/** Run a command probe. @param probe Injectable command runner. @param command Executable. @param args Arguments. @returns A failed result when the probe throws. */
function safelyProbe(probe: ProbeFn, command: string, args: string[]): ProbeResult {
  try { return probe(command, args); }
  catch (cause) { return { ok: false, error: cause instanceof Error ? cause.message : 'The check could not run.' }; }
}

/** Check local tools without changing them. @param options Probe and platform overrides for testing. @returns Required and optional check results. */
export function runDoctor(options: DoctorOptions = {}): DoctorReport {
  const probe = options.probe ?? probeTool;
  const platform = options.platform ?? process.platform;
  const version = (options.nodeVersion ?? process.version).replace(/^v/, '');
  const [major, minor] = version.split('.').map(Number);
  const nodeOk = major === 24 && (minor ?? 0) >= 15;
  const checks: CheckResult[] = [{
    name: 'Node.js', ok: nodeOk, severity: 'fatal',
    message: nodeOk ? `Node ${version} is ready.` : `Node >=24.15.0 <25 is required; found ${version}.`,
    ...(!nodeOk ? { hint: platform === 'win32' ? 'Install Node.js 24 LTS from nodejs.org or with winget.' : 'Install Node.js 24 LTS from nodejs.org or your version manager.' } : {}),
  }];
  const commands: [string, string, string[], 'fatal' | 'warning', string][] = [
    ['pnpm', 'pnpm', ['--version'], 'fatal', 'Install pnpm 9 or newer with Corepack.'],
    ['node:sqlite', process.execPath, ['--input-type=module', '-e', "import('node:sqlite')"], 'fatal', 'Use Node.js >=24.15.0 <25.'],
    ['uv', 'uv', ['--version'], 'warning', uvInstallHint(platform)],
    ['Python 3.11+', 'uv', ['python', 'list', '--only-installed'], 'warning', uvInstallHint(platform)],
  ];
  for (const [name, command, args, severity, hint] of commands) {
    const result = safelyProbe(probe, command, args);
    const pnpmMajor = Number(/^\s*(\d+)\./.exec(result.version ?? '')?.[1]);
    const ok = result.ok && (name !== 'pnpm' || pnpmMajor >= 9) &&
      (name !== 'Python 3.11+' || /\b3\.(?:1[1-9]|[2-9]\d)\b/.test(result.version ?? ''));
    checks.push({ name, ok, severity, message: ok ? `${name} is ready${result.version ? ` (${result.version.split('\n')[0]})` : ''}.` : `${name} is unavailable or too old.`, ...(!ok ? { hint } : {}) });
  }
  return { ok: checks.every((check) => check.ok || check.severity === 'warning'), checks };
}

/** Enforce fatal preflight findings. @param report Completed doctor report. @returns Nothing when required checks pass. @throws ConfigurationError otherwise. */
export function assertPreflight(report: DoctorReport): void {
  if (report.ok) return;
  throw new ConfigurationError(report.checks.filter((check) => !check.ok && check.severity === 'fatal').map((check) => `${check.message} ${check.hint ?? ''}`).join(' '));
}

/** Format a terminal report. @param report Completed doctor report. @returns Aligned, readable lines. */
export function formatDoctor(report: DoctorReport): string {
  return report.checks.map((check) => `${check.ok ? 'OK  ' : check.severity === 'fatal' ? 'FAIL' : 'WARN'} ${check.name.padEnd(14)} ${check.message}${check.hint ? ` Install: ${check.hint}` : ''}`).join('\n');
}
