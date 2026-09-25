// The lint check (FEAT-107 TASK-006): `ruff check --isolated` over the sealed
// version, from inside `verify-env/`. `--isolated` means ruff reads NO
// configuration file, so nothing beside the generated code can switch rules
// off. Selected: E9 (syntax), F (pyflakes), B (bugbear), S (flake8-bandit).
// Whether a rule blocks is the gate policy's decision, not this module's.

import { LINT_TIMEOUT_MS } from '@automate/core';
import type { CheckOutcome, RawFinding } from './check-result';
import { versionRelative } from './check-result';
import { runStaticCheck, type ToolRunner } from './static-check';

/** The rule families ruff checks. */
export const RUFF_SELECT = 'E9,F,B,S';

/** ruff's arguments for one version directory. */
export function ruffArgs(versionDir: string): string[] {
  return ['check', '--isolated', '--no-cache', '--output-format', 'json', '--select', RUFF_SELECT, versionDir];
}

interface RuffItem { readonly code?: unknown; readonly filename?: unknown; readonly message?: unknown; readonly location?: { readonly row?: unknown; readonly column?: unknown } | null }

const int = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) ? value : null);

/** Map ruff's JSON array to raw findings. ruff reports no severity: error-class rules are `high`, pyflakes `medium`, the rest `low`. */
export function parseRuff(versionDir: string, stdout: string): { findings: RawFinding[] } | null {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) return null;
  const findings = (parsed as RuffItem[]).map((item): RawFinding => {
    const code = typeof item.code === 'string' && item.code.length > 0 ? item.code : 'invalid-syntax';
    const severity = code === 'invalid-syntax' || /^(?:E9|F6|F7|F82)/.test(code) ? 'high' : code.startsWith('F') ? 'medium' : 'low';
    return { ruleCode: code, severity, confidence: null, filePath: versionRelative(versionDir, item.filename), line: int(item.location?.row), column: int(item.location?.column), message: typeof item.message === 'string' ? item.message : code };
  });
  return { findings };
}

/**
 * Run ruff over one sealed version directory.
 * @returns The lint check's outcome; `errored` when ruff could not run or its report could not be read.
 */
export function runLintCheck(run: ToolRunner, versionDir: string, signal: AbortSignal, timeoutMs = LINT_TIMEOUT_MS): Promise<CheckOutcome> {
  return runStaticCheck(run, { checkKey: 'lint', tool: 'ruff', args: ruffArgs(versionDir), timeoutMs, parse: (stdout) => parseRuff(versionDir, stdout), blockingNoun: 'code error' }, signal);
}
