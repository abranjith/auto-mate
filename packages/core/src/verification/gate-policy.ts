// ---------------------------------------------------------------------------
// The gate policy (FEAT-107 TASK-001, D14).
//
// THIS IS THE ONLY PLACE THE QUESTION "MAY THIS RUN?" IS ANSWERED. Checks and
// findings are gathered elsewhere; whether they block is decided here, by pure
// functions, and stored with each row at write time so a later policy change
// never rewrites the history of why a run was allowed.
//
// The split, provisional against open D14: findings that mean the code is
// BROKEN or DANGEROUS stop the run — a failing app-driven test re-run, any
// bandit HIGH-severity + HIGH-confidence finding, ruff's error-class rules
// (E9 syntax, F6/F7 statement errors, F82 undefined names), and failed
// integrity/entrypoint/declared-output/missing-column checks. Findings that
// mean the code is UNTIDY are advisory and rendered. A check that could not
// run is not a check that passed: an `errored` blocking check blocks.
// ---------------------------------------------------------------------------

import { CHECK_KEYS, type CheckKey, type CheckStatus, type FindingConfidence, type FindingSeverity } from './verification';

/** Checks whose failure stops the run. `lint` and `security` block through their findings instead. */
export const BLOCKING_CHECK_KEYS = ['integrity', 'contract_entrypoint', 'contract_inputs', 'contract_outputs', 'lint', 'security', 'tests'] as const satisfies readonly CheckKey[];
/** ruff rule prefixes that mean the code is broken rather than untidy. Provisional against D14. */
export const BLOCKING_RUFF_RULE_PREFIXES = ['E9', 'F6', 'F7', 'F82'] as const;
/**
 * Exact ruff codes that also block. Current ruff reports a syntax error as
 * `invalid-syntax` rather than an `E9xx` rule, so the prefix list alone would
 * let unparseable code through (observed with ruff 0.16.8, FEAT-107).
 */
export const BLOCKING_RUFF_RULE_CODES = ['invalid-syntax'] as const;
/** bandit findings block only at this severity… Provisional against D14. */
export const BLOCKING_BANDIT_SEVERITY: FindingSeverity = 'high';
/** …and this confidence, together. Provisional against D14. */
export const BLOCKING_BANDIT_CONFIDENCE: FindingConfidence = 'high';

/** What the policy needs to know about a finding. */
export interface PolicyFinding {
  readonly checkKey: CheckKey;
  readonly ruleCode: string;
  readonly severity: FindingSeverity;
  readonly confidence: FindingConfidence | null;
}

/** What the policy needs to know about a check. */
export interface PolicyCheck {
  readonly checkKey: CheckKey;
  readonly status: CheckStatus;
}

/** The gate's answer. */
export interface GateDecision {
  readonly allowed: boolean;
  readonly blockingCount: number;
  readonly advisoryCount: number;
  /** One entry per blocking check, naming the check key; for logs and tests, not for people. */
  readonly reasons: readonly CheckKey[];
}

/**
 * Decide whether one finding blocks the run.
 *
 * @param finding The check it came from, its rule, severity, and confidence.
 * @returns True for ruff error-class rules, bandit HIGH/HIGH, and every finding of an application-owned check.
 * @example isBlockingFinding({ checkKey: 'lint', ruleCode: 'F821', severity: 'high', confidence: null }) // true
 */
export function isBlockingFinding(finding: PolicyFinding): boolean {
  if (finding.checkKey === 'lint') return (BLOCKING_RUFF_RULE_CODES as readonly string[]).includes(finding.ruleCode) || BLOCKING_RUFF_RULE_PREFIXES.some((prefix) => finding.ruleCode.startsWith(prefix));
  if (finding.checkKey === 'security') return finding.severity === BLOCKING_BANDIT_SEVERITY && finding.confidence === BLOCKING_BANDIT_CONFIDENCE;
  if (finding.checkKey === 'contract_inputs') return finding.ruleCode === 'missing_column' || finding.ruleCode === 'missing_input';
  return true;
}

/**
 * Whether a check's failure stops the run.
 *
 * @param key A check key.
 * @returns True for every key in `BLOCKING_CHECK_KEYS`.
 * @example isBlockingCheck('tests') // true
 */
export function isBlockingCheck(key: CheckKey): boolean {
  return (BLOCKING_CHECK_KEYS as readonly CheckKey[]).includes(key);
}

/** A check blocks when it could not run, or when it failed and — for lint/security — carries a blocking finding. */
function checkBlocks(check: PolicyCheck, findings: readonly (PolicyFinding & { readonly isBlocking: boolean })[]): boolean {
  if (!isBlockingCheck(check.checkKey)) return false;
  if (check.status === 'errored') return true;
  if (check.status !== 'failed') return false;
  if (check.checkKey === 'lint' || check.checkKey === 'security' || check.checkKey === 'contract_inputs') return findings.some((item) => item.checkKey === check.checkKey && item.isBlocking);
  return true;
}

/**
 * Decide whether a verification pass allows the run. Pure and total.
 *
 * @param checks Every check the pass recorded; a missing key blocks, because an absent check is not a passed one.
 * @param findings Every finding, each with its resolved `isBlocking`.
 * @returns Whether the run may proceed, the blocking and advisory counts, and which checks blocked.
 * @example decideGate([{ checkKey: 'tests', status: 'failed' }], []).allowed // false
 */
export function decideGate(checks: readonly PolicyCheck[], findings: readonly (PolicyFinding & { readonly isBlocking: boolean })[]): GateDecision {
  const reasons: CheckKey[] = [];
  for (const key of CHECK_KEYS) {
    const check = checks.find((item) => item.checkKey === key);
    if (!check || checkBlocks(check, findings)) reasons.push(key);
  }
  const blockingCount = findings.filter((item) => item.isBlocking).length;
  return { allowed: reasons.length === 0, blockingCount, advisoryCount: findings.length - blockingCount, reasons };
}
