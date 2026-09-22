import { spawnSync } from 'node:child_process';

export type ProbeResult = { ok: boolean; version?: string; error?: string };
export type ProbeFn = (command: string, args: string[]) => ProbeResult;

/** Run a prerequisite command. @param command Executable to probe. @param args Fixed arguments. @returns Success and version text or an error. Uses cmd.exe only for the fixed Windows pnpm probe. */
export const probeTool: ProbeFn = (command, args) => {
  const windowsPnpm = process.platform === 'win32' && command === 'pnpm' && args.length === 1 && args[0] === '--version';
  const executable = windowsPnpm ? 'cmd.exe' : command;
  const arguments_ = windowsPnpm ? ['/d', '/s', '/c', 'pnpm --version'] : args;
  const result = spawnSync(executable, arguments_, { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (result.error || result.status !== 0) {
    return { ok: false, error: result.error?.message ?? result.stderr?.trim() ?? 'Command failed.' };
  }
  return { ok: true, version: result.stdout.trim() || result.stderr.trim() };
};
