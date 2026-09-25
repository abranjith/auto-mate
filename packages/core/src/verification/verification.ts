// ---------------------------------------------------------------------------
// Verification views (FEAT-107 TASK-001).
//
// Browser-safe shapes for one verification pass, its seven checks, and the
// concrete findings. `summarizeVerification` is the ONE place the plain-English
// verdict is worded, so the API, the transcript, and the UI cannot disagree.
// It names counts, never rule codes, and never a path.
// ---------------------------------------------------------------------------

/** The fixed set of checks every settled pass records, in the order they run and render. */
export const CHECK_KEYS = ['integrity', 'contract_entrypoint', 'contract_inputs', 'contract_outputs', 'lint', 'security', 'tests'] as const;
export type CheckKey = (typeof CHECK_KEYS)[number];

export const CHECK_STATUSES = ['passed', 'failed', 'skipped', 'errored'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export const FINDING_SEVERITIES = ['high', 'medium', 'low', 'info'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const FINDING_CONFIDENCES = ['high', 'medium', 'low'] as const;
export type FindingConfidence = (typeof FINDING_CONFIDENCES)[number];

/** `failed` is checks that ran and blocked; `errored` is the pass itself failing to complete. */
export const VERIFICATION_STATUSES = ['running', 'passed', 'failed', 'errored', 'timed_out', 'aborted'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/** One concrete thing a check found. `message` is tool output about model-written code: untrusted input to the DOM. */
export interface VerificationFindingView {
  readonly checkKey: CheckKey;
  readonly ruleCode: string;
  readonly severity: FindingSeverity;
  readonly confidence: FindingConfidence | null;
  /** Relative to the version directory; never absolute. */
  readonly filePath: string | null;
  readonly line: number | null;
  readonly column: number | null;
  readonly message: string;
  readonly isBlocking: boolean;
}

/** One check within a pass. */
export interface VerificationCheckView {
  readonly checkKey: CheckKey;
  readonly status: CheckStatus;
  readonly isBlocking: boolean;
  readonly summary: string;
  readonly detail: unknown;
  readonly durationMs: number | null;
}

/** One pass over one sealed code version on one runtime. */
export interface VerificationRunView {
  readonly status: VerificationStatus;
  readonly blockingCount: number;
  readonly advisoryCount: number;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

const CHECK_NOUNS: Readonly<Record<CheckKey, string>> = {
  integrity: 'integrity problem',
  contract_entrypoint: 'entry point problem',
  contract_inputs: 'input problem',
  contract_outputs: 'output declaration problem',
  lint: 'code error',
  security: 'high-severity security finding',
  tests: 'failing test',
};

/** Count what blocked, per check, in the policy's order. */
function blockingPhrases(checks: readonly VerificationCheckView[], findings: readonly VerificationFindingView[]): string[] {
  const phrases: string[] = [];
  for (const key of CHECK_KEYS) {
    const check = checks.find((item) => item.checkKey === key);
    if (!check || !check.isBlocking) continue;
    if (check.status === 'errored') { phrases.push(`the ${key === 'tests' ? 'tests' : key.replace('contract_', '').replace('_', ' ')} check could not run`); continue; }
    if (check.status !== 'failed') continue;
    const count = key === 'tests' ? failedTests(check) : findings.filter((item) => item.checkKey === key && item.isBlocking).length;
    phrases.push(plural(Math.max(1, count), CHECK_NOUNS[key]));
  }
  return phrases;
}

function failedTests(check: VerificationCheckView): number {
  const detail = check.detail as { failed?: unknown } | null;
  return typeof detail?.failed === 'number' ? detail.failed : 1;
}

function joinPhrases(phrases: readonly string[]): string {
  if (phrases.length <= 1) return phrases[0] ?? '';
  return `${phrases.slice(0, -1).join(', ')} and ${phrases.at(-1)}`;
}

/**
 * Word a pass's verdict as one plain-English line.
 *
 * @param run The pass's status and counts.
 * @param checks Every check the pass recorded.
 * @param findings Every stored finding.
 * @returns For example `No blocking problems found; 2 advisory findings to review.` — never a rule code or a path.
 * @example summarizeVerification({ status: 'passed', blockingCount: 0, advisoryCount: 0 }, [], []) // 'All checks passed.'
 */
export function summarizeVerification(run: VerificationRunView, checks: readonly VerificationCheckView[], findings: readonly VerificationFindingView[]): string {
  if (run.status === 'running') return 'Checking the code…';
  if (run.status === 'aborted') return 'Checking was stopped before it finished.';
  if (run.status === 'timed_out') return 'Checking took too long and was stopped, so this code cannot run yet.';
  if (run.status === 'errored') return 'The code could not be fully checked, so it cannot run yet.';
  if (run.status === 'failed') {
    const phrases = blockingPhrases(checks, findings);
    return `This code can't run yet: ${phrases.length ? joinPhrases(phrases) : plural(run.blockingCount, 'blocking problem')}.`;
  }
  return run.advisoryCount === 0 ? 'All checks passed.' : `No blocking problems found; ${plural(run.advisoryCount, 'advisory finding')} to review.`;
}
