// ---------------------------------------------------------------------------
// What to do next after a run (FEAT-109 TASK-001/010, plan §6).
//
// "Failure messages must help a person who cannot debug code take the next
// step." `describeRunOutcome` is that requirement as a pure, TOTAL function:
// every combination of run status, limit breach, manifest presence, and
// artifact count yields a headline, a detail, and at least one next step. A
// next step is an ACTION the screen wires to a control that exists — advice
// without a control is not a next step. A limit breach is worded only by
// FEAT-108's `describeLimitBreach`, never a second time here.
//
// No outcome ever names a stack trace, an absolute path, or a bare exit code
// as its headline; the exit code stays in FEAT-107's run detail.
// ---------------------------------------------------------------------------

import type { ScriptRunStatus } from '../contracts/verification-api';
import { describeLimitBreach, type LimitBreach } from '../execution/runtime-environment';

/** A control the outcome panel renders. Every member must have one. */
export const NEXT_STEP_ACTIONS = ['review_result', 'download_produced', 'retry_with_detail', 'adjust_request', 'open_transcript', 'open_checks', 'prepare_runtime', 'cancel'] as const;
export type NextStepAction = (typeof NEXT_STEP_ACTIONS)[number];

export interface NextStep {
  readonly action: NextStepAction;
  /** The control's label. */
  readonly label: string;
}

export type OutcomeTone = 'success' | 'notice' | 'problem';

export interface RunOutcome {
  readonly tone: OutcomeTone;
  readonly headline: string;
  /** FEAT-108's `describeLimitBreach` sentence, verbatim, when a limit stopped the run; shown on its own line. */
  readonly limit: string | null;
  readonly detail: string;
  readonly nextSteps: readonly NextStep[];
}

/** The facts about a run the outcome is decided from. */
export interface RunOutcomeInput {
  readonly status: ScriptRunStatus;
  readonly exitCode: number | null;
  readonly limitBreached: LimitBreach | null;
  readonly manifestPresent: boolean | null;
  readonly declaredOutputCount: number | null;
  /** Declared files that were never written; 0 when unknown. */
  readonly missingDeclaredCount?: number;
}

const STEP: Readonly<Record<NextStepAction, NextStep>> = {
  review_result: { action: 'review_result', label: 'Look over the results and tell me if they are right' },
  download_produced: { action: 'download_produced', label: 'Download what it produced' },
  retry_with_detail: { action: 'retry_with_detail', label: 'Try again, telling me more about what you want' },
  adjust_request: { action: 'adjust_request', label: 'Ask for something smaller or simpler' },
  open_transcript: { action: 'open_transcript', label: 'See what happened, step by step' },
  open_checks: { action: 'open_checks', label: 'See what the checks found' },
  prepare_runtime: { action: 'prepare_runtime', label: 'Open Settings to prepare Python' },
  cancel: { action: 'cancel', label: 'Stop the run' },
};

const files = (count: number) => `${count} file${count === 1 ? '' : 's'}`;
const steps = (...actions: readonly (NextStepAction | false)[]): NextStep[] => actions.filter((action): action is NextStepAction => action !== false).map((action) => STEP[action]);
const kept = (count: number) => (count > 0 ? ` The ${files(count)} it wrote before stopping ${count === 1 ? 'is' : 'are'} kept below.` : ' Nothing it wrote was kept.');

function limitOutcome(breach: LimitBreach, count: number): RunOutcome {
  return { tone: 'problem', headline: 'The run hit a limit and was stopped.', limit: describeLimitBreach(breach), detail: kept(count).trim(), nextSteps: steps('adjust_request', count > 0 && 'download_produced', 'open_transcript') };
}

function failedOutcome(run: RunOutcomeInput, count: number): RunOutcome {
  if (run.exitCode !== 0) return { tone: 'problem', headline: 'The script stopped before it finished.', limit: null, detail: `It ran into a problem partway through, so the result is incomplete.${kept(count)}`, nextSteps: steps('retry_with_detail', count > 0 && 'download_produced', 'open_transcript') };
  if (!run.manifestPresent) return { tone: 'notice', headline: 'The script finished but did not say what it produced.', limit: null, detail: count > 0 ? `It wrote ${files(count)} without listing them; they are kept below and marked.` : 'It did not write any files either.', nextSteps: steps(count > 0 && 'download_produced', 'retry_with_detail') };
  const declared = run.declaredOutputCount ?? 0;
  const missing = Math.min(declared, run.missingDeclaredCount ?? 0);
  return { tone: 'notice', headline: 'Some of the promised files are missing.', limit: null, detail: missing > 0 ? `It said it would produce ${files(declared)}, but ${missing} ${missing === 1 ? 'was' : 'were'} not written. ${count > 0 ? `The ${files(count)} it did write ${count === 1 ? 'is' : 'are'} below.` : 'Nothing was written.'}` : `Its files do not match what it listed.${count > 0 ? ` The ${files(count)} it wrote ${count === 1 ? 'is' : 'are'} below.` : ''}`, nextSteps: steps(count > 0 && 'download_produced', 'retry_with_detail') };
}

function succeededOutcome(count: number): RunOutcome {
  if (count === 0) return { tone: 'notice', headline: 'The script finished, and it produced no files.', limit: null, detail: 'It ran to the end without writing anything to keep. Asking again with more detail usually fixes this.', nextSteps: steps('retry_with_detail', 'adjust_request') };
  return { tone: 'success', headline: 'Your results are ready.', limit: null, detail: `It produced ${files(count)}.`, nextSteps: steps('review_result', 'download_produced') };
}

/**
 * Decide what a person is told after a run, and what they can do about it.
 *
 * @param run The settled run's status, exit code, limit breach, and manifest facts.
 * @param artifacts The run's registered artifacts (only their number matters).
 * @returns A headline, a detail sentence, and at least one next step. Total over every input.
 * @example describeRunOutcome({ status: 'succeeded', exitCode: 0, limitBreached: null, manifestPresent: true, declaredOutputCount: 1 }, [{}]).headline // 'Your results are ready.'
 */
export function describeRunOutcome(run: RunOutcomeInput, artifacts: readonly unknown[]): RunOutcome {
  const count = artifacts.length;
  if (run.status === 'running') return { tone: 'notice', headline: 'The script is still running.', limit: null, detail: 'Its results will appear here when it finishes.', nextSteps: steps('cancel', 'open_transcript') };
  if (run.limitBreached) return limitOutcome(run.limitBreached, count);
  switch (run.status) {
    case 'aborted': return { tone: 'notice', headline: 'The run was stopped.', limit: null, detail: `You or the application stopped it before it finished.${kept(count)}`, nextSteps: steps('retry_with_detail', count > 0 && 'download_produced') };
    case 'timed_out': return limitOutcome('time', count);
    case 'errored': return { tone: 'problem', headline: 'The script could not be started.', limit: null, detail: 'Python or its packages are not ready on this computer. Prepare them in Settings, then try again.', nextSteps: steps('prepare_runtime', 'retry_with_detail') };
    case 'failed': return failedOutcome(run, count);
    case 'succeeded': return succeededOutcome(count);
  }
}
