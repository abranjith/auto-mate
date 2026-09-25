// The security check (FEAT-107 TASK-006): `bandit -r -c <app config> --ini
// <app ini>` over the sealed version, from inside `verify-env/`. The explicit
// `-c` makes the profile the application's own `bandit.yaml`, and the explicit
// `--ini` stops bandit reading a `.bandit` file in the checked tree — which it
// otherwise does even with `-c` (observed with bandit 1.9.4). A HIGH-severity,
// HIGH-confidence finding blocks; everything else is advisory.
//
// A file bandit could not PARSE is not a file bandit checked: each entry in
// its `errors` array becomes a blocking finding, because "we could not check
// this" and "this passed" must never resolve to the same behavior.

import { SECURITY_TIMEOUT_MS, type FindingConfidence, type FindingSeverity } from '@automate/core';
import type { CheckOutcome, RawFinding } from './check-result';
import { versionRelative } from './check-result';
import { runStaticCheck, type ToolRunner } from './static-check';

/** The application-owned files bandit is pointed at; both live in `verify-env/`, never beside the checked code. */
export interface BanditConfig { readonly configPath: string; readonly iniPath: string }

/** bandit's arguments for one version directory and the application's config files. */
export function banditArgs(versionDir: string, config: BanditConfig): string[] {
  return ['-r', '-f', 'json', '-q', '-c', config.configPath, '--ini', config.iniPath, versionDir];
}

interface BanditResult { readonly test_id?: unknown; readonly issue_severity?: unknown; readonly issue_confidence?: unknown; readonly filename?: unknown; readonly line_number?: unknown; readonly col_offset?: unknown; readonly issue_text?: unknown }
interface BanditError { readonly filename?: unknown; readonly reason?: unknown }

const LEVELS = ['high', 'medium', 'low'] as const;
const level = (value: unknown): (typeof LEVELS)[number] | null => {
  const lowered = typeof value === 'string' ? value.toLowerCase() : '';
  return (LEVELS as readonly string[]).includes(lowered) ? (lowered as (typeof LEVELS)[number]) : null;
};
const int = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) ? value : null);

/** Map bandit's JSON report to raw findings, severities and confidences lowercased. */
export function parseBandit(versionDir: string, stdout: string): { findings: RawFinding[] } | null {
  const parsed = JSON.parse(stdout) as { results?: unknown; errors?: unknown };
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.results)) return null;
  const results = (parsed.results as BanditResult[]).map((item): RawFinding => ({
    ruleCode: typeof item.test_id === 'string' ? item.test_id : 'unknown',
    severity: (level(item.issue_severity) ?? 'info') as FindingSeverity,
    confidence: level(item.issue_confidence) as FindingConfidence | null,
    filePath: versionRelative(versionDir, item.filename),
    line: int(item.line_number),
    column: int(item.col_offset),
    message: typeof item.issue_text === 'string' ? item.issue_text : 'bandit reported a problem.',
  }));
  const errors = (Array.isArray(parsed.errors) ? (parsed.errors as BanditError[]) : []).map((item): RawFinding => ({ ruleCode: 'scan_error', severity: 'high', confidence: 'high', filePath: versionRelative(versionDir, item.filename), line: null, column: null, message: 'bandit could not read this file, so it was not checked for security problems.' }));
  return { findings: [...errors, ...results] };
}

/**
 * Run bandit over one sealed version directory.
 * @param config The application-owned `bandit.yaml` and `bandit.ini` in `verify-env/`.
 */
export function runSecurityCheck(run: ToolRunner, versionDir: string, config: BanditConfig, signal: AbortSignal, timeoutMs = SECURITY_TIMEOUT_MS): Promise<CheckOutcome> {
  return runStaticCheck(run, { checkKey: 'security', tool: 'bandit', args: banditArgs(versionDir, config), timeoutMs, parse: (stdout) => parseBandit(versionDir, stdout), blockingNoun: 'high-severity security finding' }, signal);
}
