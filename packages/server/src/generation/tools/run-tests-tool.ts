// ---------------------------------------------------------------------------
// `run_tests` (FEAT-106 TASK-008): the attempt cap, the filter, the receipts.
//
// pytest's output is UNTRUSTED BYTES FROM UNISOLATED CODE. The generated code
// under test can read any file this server can (D03), so its stdout would
// otherwise flow straight into the model's context on the next repair turn.
// It reaches the model ONLY through FEAT-105's `recordDiagnosticTransmission`,
// which applies the default-deny allowlist and records what was sent against
// the person's consent. A branch that returns raw output defeats FEAT-105
// entirely; a static test guards `consumeRawOutput` as the single reader.
//
// A refusal is an expected outcome the loop is designed to end on: it is
// recorded, rendered, and returned — never thrown.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  AutoMateError,
  ERROR_CODES,
  RunTestsArgsSchema,
  TEST_RUN_TIMEOUT_MS,
  type AgentToolDefinition,
  type AttemptStatus,
  type PythonRunResult,
  type PythonRunner,
  type RefusalReason,
  type UnnumberedConversationEvent,
} from '@automate/core';
import type { Logger } from 'pino';
import type { CodeVersionWithFiles } from '../../db/repositories/code-version-repository';
import type { ExecutionRepository } from '../../db/repositories/execution-repository';
import type { GenerationAttemptRepository } from '../../db/repositories/generation-attempt-repository';
import type { DisclosureTransmissionRepository } from '../../db/repositories/disclosure-transmission-repository';
import type { GenerationRun, GenerationRuns } from '../generation-run';
import { parsePytestReport, type PytestReport } from '../pytest-report';
import { assertNotFinal, executionIdOf, sealedEvent, type GenerationToolDependencies } from './tool-context';

/** pytest, quietly, with native tracebacks (the frame shape the diagnostic allowlist recognizes) and no cache directory. */
export const PYTEST_ARGS = ['-m', 'pytest', '-q', '--tb=native', '-rfE', '-p', 'no:cacheprovider'] as const;

export interface RunTestsToolDependencies extends GenerationToolDependencies {
  readonly attempts: GenerationAttemptRepository;
  readonly executions: ExecutionRepository;
  readonly runs: GenerationRuns;
  readonly runner: PythonRunner;
  /** FEAT-105: throws unless the task's live consent covers sending diagnostics. */
  readonly consent: { verifyForTransmission(taskId: number, kind: 'diagnostics'): unknown };
  /** FEAT-105: the only supported route from raw failure output to a prompt. */
  readonly diagnostics: { recordDiagnosticTransmission(executionId: number, rawDiagnostics: string): string };
  readonly transmissions: DisclosureTransmissionRepository;
  readonly fixturesDir: (executionId: number) => string;
  readonly publish: (executionId: number, event: UnnumberedConversationEvent) => void;
  readonly logger: Pick<Logger, 'info' | 'warn'>;
  readonly testRunTimeoutMs?: number;
}

/** What the model gets back from one call. */
export type RunTestsResult =
  | { readonly outcome: Exclude<AttemptStatus, 'running' | 'refused'>; readonly testsTotal: number | null; readonly testsPassed: number | null; readonly testsFailed: number | null; readonly diagnostics: string | null; readonly droppedLineCount: number | null; readonly attemptsRemaining: number; readonly manifestPresent: boolean | null; readonly message: string }
  | { readonly outcome: 'refused'; readonly refusalReason: RefusalReason; readonly attemptsRemaining: number; readonly message: string };

const FINALIZE = 'Do not call run_tests again. Call finalize_script with your best version now.';
const REFUSAL_MESSAGES: Readonly<Record<Exclude<RefusalReason, 'runtime_unavailable'>, string>> = {
  attempt_limit: `Every allowed test run has been used. ${FINALIZE}`,
  time_limit: `This run has reached its time limit. ${FINALIZE}`,
  cost_limit: `This run has reached its cost limit. ${FINALIZE}`,
  diagnostics_not_granted: `The person did not approve sending test failure details, so the application will not run and repair tests here; it will stop and ask them instead. ${FINALIZE}`,
};

/** Build the `run_tests` tool. @param deps Repositories, the runner seam, FEAT-105's consent and diagnostic chokepoint, and the transcript publisher. */
export function createRunTestsTool(deps: RunTestsToolDependencies): AgentToolDefinition<typeof RunTestsArgsSchema> {
  const executor = new RunTestsExecutor(deps);
  return {
    name: 'run_tests',
    description: 'Seal the files written so far as the next attempt and run its pytest tests against synthetic data shaped like the person\'s file. Takes no arguments. Returns the outcome, test counts, FILTERED failure details (unrecognized output lines are withheld and counted), and how many attempts remain. The number of runs is limited by the application; when it refuses, call finalize_script with your best version.',
    parameters: RunTestsArgsSchema,
    execute: (_args, context) => executor.execute(executionIdOf(context), context.callId),
  };
}

/** Runs one `run_tests` call in the fixed order: budget, consent, runtime, seal, run, filter, settle. */
export class RunTestsExecutor {
  constructor(private readonly deps: RunTestsToolDependencies) {}

  async execute(executionId: number, callId: string): Promise<RunTestsResult> {
    const run = this.deps.runs.get(executionId);
    if (!run) throw new AutoMateError('EXECUTION_NOT_RUNNING', 'Tests can only run while the execution is generating.');
    assertNotFinal(this.deps.versions, executionId);
    const claim = run.budget.claimAttempt();
    if (!claim.granted) return this.refuse(run, callId, claim.reason);
    try { this.deps.consent.verifyForTransmission(run.taskId, 'diagnostics'); }
    catch (cause) {
      if (isConsentRefusal(cause)) return this.refuse(run, callId, 'diagnostics_not_granted');
      throw cause;
    }
    try {
      await this.deps.runner.probe();
      await this.deps.runner.ensureEnvironment(run.signal);
    } catch (cause) {
      if (run.signal.aborted) return { outcome: 'aborted', testsTotal: null, testsPassed: null, testsFailed: null, diagnostics: null, droppedLineCount: null, attemptsRemaining: run.budget.remaining(), manifestPresent: null, message: 'Stopped before the tests ran.' };
      return this.refuse(run, callId, 'runtime_unavailable', cause instanceof Error ? cause.message : undefined);
    }
    const version = this.deps.workspace.seal(executionId);
    this.publishSealed(executionId, version);
    return this.test(run, version, callId);
  }

  /** Run the sealed version's tests and settle its attempt. */
  private async test(run: GenerationRun, version: CodeVersionWithFiles, callId: string): Promise<RunTestsResult> {
    const executionId = run.executionId;
    const attempt = this.deps.attempts.open({ executionId, codeVersionId: version.id, attempt: version.attempt, callId });
    const outputDir = this.deps.workspace.outputDir(version);
    let result: PythonRunResult;
    try { result = await this.deps.runner.run({ executionId, workingDir: this.deps.workspace.attemptDir(version), args: PYTEST_ARGS, env: { AUTOMATE_INPUT_DIR: this.deps.fixturesDir(executionId), AUTOMATE_OUTPUT_DIR: outputDir }, timeoutMs: this.deps.testRunTimeoutMs ?? TEST_RUN_TIMEOUT_MS, signal: run.signal }); }
    catch (cause) {
      this.deps.attempts.settle(attempt.id, { status: 'errored' });
      throw cause;
    }
    let consumed: { report: PytestReport; filtered: string | null } = { report: { total: null, passed: null, failed: null, collectionError: false }, filtered: null };
    try { consumed = this.consumeRawOutput(executionId, result); }
    finally { this.settle(executionId, attempt.id, version.id, result, consumed, outputDir); }
    const settled = this.deps.attempts.listByExecution(executionId).find(({ id }) => id === attempt.id)!;
    const remaining = run.budget.remaining();
    this.deps.publish(executionId, { type: 'test_run_finished', attemptId: attempt.id, attempt: version.attempt, outcome: result.outcome, refusalReason: null, testsTotal: settled.testsTotal, testsPassed: settled.testsPassed, testsFailed: settled.testsFailed, droppedLineCount: settled.droppedLineCount, attemptsRemaining: remaining, attemptLimit: run.budget.limits.maxAttempts, manifestPresent: settled.manifestPresent, at: new Date().toISOString() });
    this.deps.logger.info({ executionId, attempt: version.attempt, outcome: result.outcome, testsTotal: settled.testsTotal, testsFailed: settled.testsFailed, durationMs: result.durationMs }, 'generation attempt settled');
    return { outcome: result.outcome, testsTotal: settled.testsTotal, testsPassed: settled.testsPassed, testsFailed: settled.testsFailed, diagnostics: consumed.filtered, droppedLineCount: settled.droppedLineCount, attemptsRemaining: remaining, manifestPresent: settled.manifestPresent, message: nextStep(result.outcome, remaining) };
  }

  /**
   * THE ONLY READER OF RAW PROCESS OUTPUT. Counts are parsed locally; text
   * leaves only through FEAT-105's `recordDiagnosticTransmission`, and only
   * for a run that did not pass. Nothing here is logged.
   */
  private consumeRawOutput(executionId: number, result: PythonRunResult): { report: PytestReport; filtered: string | null } {
    const raw = `${result.stdout}\n${result.stderr}`;
    const report = parsePytestReport(raw);
    const filtered = result.outcome === 'passed' || result.outcome === 'aborted' ? null : this.deps.diagnostics.recordDiagnosticTransmission(executionId, raw);
    return { report, filtered };
  }

  /** Record the attempt's outcome and the version's tested state. Called even when filtering failed, so no attempt stays running. */
  private settle(executionId: number, attemptId: number, versionId: number, result: PythonRunResult, consumed: { report: PytestReport; filtered: string | null }, outputDir: string): void {
    const tested = result.outcome !== 'aborted';
    if (tested) this.deps.versions.markTested(versionId, result.outcome === 'passed');
    const receipt = consumed.filtered === null ? undefined : this.deps.transmissions.listByExecution(executionId).at(-1);
    const dropped = receipt ? (JSON.parse(receipt.summary) as { droppedLineCount?: number }).droppedLineCount ?? null : null;
    this.deps.attempts.settle(attemptId, { status: result.outcome, testsTotal: consumed.report.total, testsPassed: consumed.report.passed, testsFailed: consumed.report.failed, exitCode: result.exitCode, manifestPresent: tested ? manifestPresent(outputDir) : null, diagnosticDigest: consumed.filtered === null ? null : createHash('sha256').update(consumed.filtered).digest('hex'), droppedLineCount: dropped, durationMs: result.durationMs });
  }

  /** Record, render, and return a refusal. It seals nothing and runs nothing. */
  private refuse(run: GenerationRun, callId: string, reason: RefusalReason, detail?: string): RunTestsResult {
    const executionId = run.executionId;
    const draft = this.deps.versions.findDraft(executionId);
    const number = draft && !this.deps.attempts.getByNumber(executionId, draft.attempt) ? draft.attempt : this.deps.versions.nextAttemptNumber(executionId);
    const row = this.deps.attempts.refuse({ executionId, attempt: number, callId, reason });
    const remaining = run.budget.remaining();
    this.deps.publish(executionId, { type: 'test_run_finished', attemptId: row.id, attempt: number, outcome: 'refused', refusalReason: reason, testsTotal: null, testsPassed: null, testsFailed: null, droppedLineCount: null, attemptsRemaining: remaining, attemptLimit: run.budget.limits.maxAttempts, manifestPresent: null, at: new Date().toISOString() });
    this.deps.logger.warn({ executionId, attempt: number, reason }, 'generation attempt refused');
    const message = reason === 'runtime_unavailable' ? `${detail ?? 'uv or Python is not available on this computer.'} ${FINALIZE}` : REFUSAL_MESSAGES[reason];
    return { outcome: 'refused', refusalReason: reason, attemptsRemaining: remaining, message };
  }

  private publishSealed(executionId: number, version: CodeVersionWithFiles): void {
    this.deps.publish(executionId, sealedEvent(version));
  }
}

/** FEAT-105's consent failures, which mean diagnostics may not be sent. Anything else is a real error. */
function isConsentRefusal(cause: unknown): boolean {
  return cause instanceof AutoMateError && ([ERROR_CODES.DISCLOSURE_CONSENT_REQUIRED, ERROR_CODES.DISCLOSURE_CONSENT_STALE, ERROR_CODES.DISCLOSURE_SCOPE_NOT_GRANTED] as string[]).includes(cause.code);
}

/** Whether the run left a parseable `manifest.json`. An observation only: it never changes the outcome (FEAT-107 enforces). */
export function manifestPresent(outputDir: string): boolean {
  const file = path.join(outputDir, 'manifest.json');
  if (!existsSync(file)) return false;
  try { JSON.parse(readFileSync(file, 'utf8')); return true; }
  catch { return false; }
}

function nextStep(outcome: RunTestsResult['outcome'], remaining: number): string {
  if (outcome === 'passed') return 'All tests passed. If the script is complete, call finalize_script.';
  if (outcome === 'aborted') return 'The run was stopped.';
  return remaining > 0 ? `Fix the problem shown in the filtered diagnostics, rewrite the files, and call run_tests again. ${remaining} attempt${remaining === 1 ? '' : 's'} left.` : `No attempts are left. ${FINALIZE}`;
}
