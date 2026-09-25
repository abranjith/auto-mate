// ---------------------------------------------------------------------------
// One verification pass (FEAT-107 TASK-009): the seven checks, in order,
// under one wall clock and one AbortSignal threaded into every spawn.
//
//   integrity → contract_entrypoint → contract_inputs → contract_outputs
//             → lint → security → tests
//
// The pass stops early ONLY when integrity fails — checking code whose bytes
// do not match its digest would produce results bound to nothing — or when
// it is aborted or times out. Every check that did not run is returned as
// `skipped` with the reason, so the written key set always equals CHECK_KEYS.
// This module decides nothing about the gate; `decideGate` does.
// ---------------------------------------------------------------------------

import path from 'node:path';
import { AutoMateError, CHECK_KEYS, type CheckKey, type PythonRunner } from '@automate/core';
import type { NewCheck } from '../db/repositories/verification-repository';
import { skippedCheck } from '../db/repositories/verification-repository';
import type { CodeVersionWithFiles } from '../db/repositories/code-version-repository';
import type { SyntheticFixtureRow } from '../db/repositories/synthetic-fixture-repository';
import { erroredOutcome, toNewCheck, type CheckOutcome } from './checks/check-result';
import { checkEntrypoint, checkInputs, checkOutputs, type ProfiledInput } from './checks/contract-checks';
import { runIntegrityCheck, type IntegrityDependencies } from './checks/integrity-check';
import { runLintCheck } from './checks/lint-check';
import { runSecurityCheck, type BanditConfig } from './checks/security-check';
import { runTestCheck } from './checks/test-check';
import type { ToolRunner } from './checks/static-check';

/** The checker environment, as the pass uses it. */
export interface CheckerEnvironment {
  ensureVerifyEnvironment(signal: AbortSignal): Promise<void>;
  readonly runTool: ToolRunner;
  readonly bandit: BanditConfig;
}

export interface PassInputs {
  readonly executionId: number;
  readonly version: CodeVersionWithFiles;
  readonly fixtures: readonly SyntheticFixtureRow[];
  readonly uploads: readonly ProfiledInput[];
  /** `runs/{executionId}/verify/` — fixtures are rebuilt into `input/` beneath it. */
  readonly verifyDir: string;
}

export interface PassDependencies {
  readonly integrity: IntegrityDependencies;
  readonly checkers: CheckerEnvironment;
  readonly runner: PythonRunner;
  readonly limits: { readonly lintTimeoutMs: number; readonly securityTimeoutMs: number; readonly testRunTimeoutMs: number };
}

/** The checks a pass produced, and whether it was cut short. */
export interface PassResult {
  readonly checks: readonly NewCheck[];
  readonly interrupted: boolean;
}

/** Collects outcomes in `CHECK_KEYS` order and fills in whatever never ran. */
class CheckLedger {
  private readonly done = new Map<CheckKey, NewCheck>();
  record(key: CheckKey, outcome: CheckOutcome): void { this.done.set(key, toNewCheck(key, outcome, false)); }
  has(key: CheckKey): boolean { return this.done.has(key); }
  complete(reason: string): NewCheck[] { return CHECK_KEYS.map((key) => this.done.get(key) ?? skippedCheck(key, reason)); }
}

/** Run the static checkers, reporting both as errored when the checker environment cannot be prepared. */
async function staticChecks(deps: PassDependencies, versionDir: string, ledger: CheckLedger, signal: AbortSignal): Promise<void> {
  try {
    await deps.checkers.ensureVerifyEnvironment(signal);
  } catch (cause) {
    const reason = cause instanceof AutoMateError ? cause.message : 'The code checkers could not be prepared.';
    ledger.record('lint', erroredOutcome(reason, null, { tool: 'ruff' }));
    ledger.record('security', erroredOutcome(reason, null, { tool: 'bandit' }));
    return;
  }
  ledger.record('lint', await runLintCheck(deps.checkers.runTool, versionDir, signal, deps.limits.lintTimeoutMs));
  if (signal.aborted) return;
  ledger.record('security', await runSecurityCheck(deps.checkers.runTool, versionDir, deps.checkers.bandit, signal, deps.limits.securityTimeoutMs));
}

/**
 * Run every check in order.
 * @param signal Aborts on a person's cancel or the pass's wall clock; each spawn receives it.
 * @returns Seven checks — those that did not run are `skipped` with the reason — and whether the pass was cut short.
 */
export async function runVerificationPass(deps: PassDependencies, inputs: PassInputs, signal: AbortSignal): Promise<PassResult> {
  const ledger = new CheckLedger();
  const fixtureDir = path.join(inputs.verifyDir, 'input');
  const integrity = await runIntegrityCheck(deps.integrity, inputs.version, inputs.fixtures, fixtureDir);
  ledger.record('integrity', integrity.outcome);
  if (!integrity.versionDir || !integrity.fixtures) return { checks: ledger.complete('Not run: the code or its test data did not match what was recorded.'), interrupted: false };
  ledger.record('contract_entrypoint', checkEntrypoint(inputs.version));
  ledger.record('contract_inputs', checkInputs(inputs.version, inputs.uploads));
  ledger.record('contract_outputs', checkOutputs(inputs.version));
  if (!signal.aborted) await staticChecks(deps, integrity.versionDir, ledger, signal);
  if (!signal.aborted) ledger.record('tests', await runTestCheck({ runner: deps.runner, executionId: inputs.executionId, versionDir: integrity.versionDir, fixtures: integrity.fixtures, verifyDir: inputs.verifyDir, timeoutMs: deps.limits.testRunTimeoutMs, signal }));
  const interrupted = signal.aborted;
  return { checks: ledger.complete(interrupted ? 'Not run: checking was stopped first.' : 'Not run.'), interrupted };
}
