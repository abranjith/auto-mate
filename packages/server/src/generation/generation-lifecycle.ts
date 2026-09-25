// ---------------------------------------------------------------------------
// How a generation phase ends (FEAT-106 TASK-010/011).
//
// The application tracks the repair loop; it does not drive it. This is where
// the tracking becomes a terminal state, decided once, from the database, and
// explained in one `generation_settled` event:
//
//   aborted by the person            → aborted
//   wall clock or spend stopped it   → failed, GENERATION_TIMEOUT / _COST_LIMIT
//   the provider failed              → failed, the provider's error
//   diagnostics refused / no runtime → failed, and says why (no attempt passed)
//   every attempt used, none passed  → failed, GENERATION_ATTEMPTS_EXHAUSTED
//   a final version was chosen       → completed (FEAT-107 judges it next)
//   anything else                    → failed, CODE_VERSION_NOT_FINAL
//
// Exhaustion wins over a finalized version: D07 says a run whose attempts all
// failed settles `failed` and offers a guidance retry, and the agent is told
// to finalize its best version when refused, so both happen together. The
// finalized version stays recorded and readable either way.
// ---------------------------------------------------------------------------

import {
  CodeVersionNotFinalError,
  GenerationAttemptsExhaustedError,
  GenerationCostLimitError,
  PythonRuntimeUnavailableError,
  summarizeAttempts,
  type AgentUsage,
  type AttemptStatus,
  type AutoMateError,
  type ExecutionStatus,
  type GenerationOutcome,
  type RefusalReason,
} from '@automate/core';
import type { Logger } from 'pino';
import type { CodeVersionRepository, CodeVersionRow } from '../db/repositories/code-version-repository';
import type { GenerationAttemptRepository, GenerationAttemptRow } from '../db/repositories/generation-attempt-repository';
import type { RunEnding, RunLifecycle, RunSettlement } from '../conversation/run-strategy';
import { uvInstallHint } from '../preflight/doctor';
import { PYTHON_INSTALL_HINT } from '../execution/uv-python-runner';
import type { GenerationRun, GenerationRuns } from './generation-run';

export interface GenerationLifecycleDependencies {
  readonly run: GenerationRun;
  readonly runs: GenerationRuns;
  readonly versions: CodeVersionRepository;
  readonly attempts: GenerationAttemptRepository;
  readonly logger: Pick<Logger, 'info' | 'warn'>;
  readonly platform?: NodeJS.Platform;
}

interface Decision { readonly outcome: GenerationOutcome; readonly status: RunSettlement['status']; readonly error?: { readonly code: string; readonly message: string } }

const DIAGNOSTICS_REFUSED = { code: 'DISCLOSURE_SCOPE_NOT_GRANTED', message: 'Testing and repairing the script needs permission to send filtered failure details, and that was not approved for this task, so the run stopped instead of repairing. Review what is sent and allow failure details, or try again with guidance.' };

const errorOf = (error: AutoMateError) => ({ code: error.code, message: error.message });

/** The `RunLifecycle` a generation run hands to `TaskSession`. */
export class GenerationLifecycle implements RunLifecycle {
  constructor(private readonly deps: GenerationLifecycleDependencies) {}

  timeRemainingMs(): number { return this.deps.run.budget.timeRemainingMs(); }
  timeoutError(): AutoMateError { return this.deps.run.budget.timeoutError(); }

  /** Feed spend; once a final version exists the work is done and no limit stops the run. */
  onTurnFinished(usage: AgentUsage): AutoMateError | null {
    this.deps.run.budget.recordUsage(usage);
    if (this.deps.versions.findFinal(this.deps.run.executionId)) return null;
    return this.deps.run.budget.stopReason();
  }

  /** Pause the wall clock while the run waits for a person; resume it when the run continues. */
  onStatusChanged(to: ExecutionStatus): void {
    if (to === 'waiting') this.deps.run.budget.pause();
    else this.deps.run.budget.resume();
  }

  cancel(): void { this.deps.run.cancel(); }

  /** Decide the terminal state from the database, tidy leftovers, and explain it once. */
  settle(ending: RunEnding): RunSettlement {
    const executionId = this.deps.run.executionId;
    this.deps.attempts.abortRunning(executionId);
    this.deps.versions.supersedeDraft(executionId);
    this.deps.runs.close(executionId);
    const attempts = this.deps.attempts.listByExecution(executionId);
    const final = this.deps.versions.findFinal(executionId);
    const decision = this.decide(ending, attempts, final);
    const limit = this.deps.run.budget.limits.maxAttempts;
    const summary = summarizeAttempts(attempts.map(view), { limit, outcome: decision.outcome, finalAttempt: final?.attempt ?? null, finalTestsPassed: final?.testsPassed ?? null });
    const used = attempts.filter(({ status }) => status !== 'refused').length;
    this.deps.logger.info({ executionId, outcome: decision.outcome, attemptsUsed: used, codeVersionId: final?.id ?? null }, 'generation settled');
    return { status: decision.status, ...(decision.error ? { error: decision.error } : {}), events: [{ type: 'generation_settled', outcome: decision.outcome, codeVersionId: final?.id ?? null, digest: final?.contentDigest ?? null, attemptsUsed: used, attemptLimit: limit, summary, at: new Date().toISOString() }] };
  }

  private decide(ending: RunEnding, attempts: readonly GenerationAttemptRow[], final: CodeVersionRow | undefined): Decision {
    if (ending.stopError) return { outcome: ending.stopError.code === 'GENERATION_COST_LIMIT' ? 'cost_limit' : 'timed_out', status: 'failed', error: errorOf(ending.stopError) };
    if (ending.outcome === 'aborted') return { outcome: 'aborted', status: 'aborted' };
    if (ending.outcome === 'failed') return { outcome: 'incomplete', status: 'failed', ...(ending.failure ? { error: ending.failure } : {}) };
    return this.decideCompleted(attempts, final);
  }

  private decideCompleted(attempts: readonly GenerationAttemptRow[], final: CodeVersionRow | undefined): Decision {
    const limits = this.deps.run.budget.limits;
    const passed = attempts.some(({ status }) => status === 'passed');
    const refused = (reason: RefusalReason) => attempts.some(({ refusalReason }) => refusalReason === reason);
    const used = attempts.filter(({ status }) => status !== 'refused').length;
    if (!passed && refused('diagnostics_not_granted')) return { outcome: 'incomplete', status: 'failed', error: DIAGNOSTICS_REFUSED };
    if (!passed && refused('runtime_unavailable')) return { outcome: 'incomplete', status: 'failed', error: errorOf(runtimeUnavailable(this.deps.platform ?? process.platform)) };
    if (!passed && used >= limits.maxAttempts) return { outcome: 'exhausted', status: 'failed', error: errorOf(new GenerationAttemptsExhaustedError(limits.maxAttempts, used)) };
    if (!passed && refused('time_limit')) return { outcome: 'timed_out', status: 'failed', error: errorOf(this.deps.run.budget.timeoutError()) };
    if (!passed && refused('cost_limit')) return { outcome: 'cost_limit', status: 'failed', error: errorOf(new GenerationCostLimitError(limits.maxCostUsd, this.deps.run.budget.spentUsd() ?? 0)) };
    if (final) return { outcome: 'finalized', status: 'completed' };
    return { outcome: 'incomplete', status: 'failed', error: errorOf(new CodeVersionNotFinalError()) };
  }
}

/** The refusal row does not say which tool was missing, so the settled message names both and how to get each. */
function runtimeUnavailable(platform: NodeJS.Platform): PythonRuntimeUnavailableError {
  const hint = uvInstallHint(platform);
  return new PythonRuntimeUnavailableError('uv', hint, `The generated tests could not run because uv or Python 3.11 or newer is not available on this computer, or the Python environment could not be prepared. Install uv with: ${hint} — then install Python with: ${PYTHON_INSTALL_HINT}. Then try again.`);
}

function view(row: GenerationAttemptRow) {
  return { attempt: row.attempt, status: row.status as AttemptStatus, refusalReason: row.refusalReason as RefusalReason | null, testsTotal: row.testsTotal, testsPassed: row.testsPassed, testsFailed: row.testsFailed };
}
