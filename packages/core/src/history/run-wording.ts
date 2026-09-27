// This module is the single source of the plain-English wording in History.
import { ERROR_CODES } from '../errors/error-codes';
import type { ExecutionStatus } from '../conversation/execution-state';
import type { ReuseKind } from '../reuse/reuse-kind';

export type ExecutionTrigger = 'manual' | 'rerun' | 'feedback';
export type RunStateDescription = { label: string; detail: string | null };

/**
 * Describe an execution without exposing error codes as labels.
 * @param run The state and optional recorded outcome code.
 * @returns A short label and optional explanation.
 * @example describeRunState({ status: 'completed', errorCode: null })
 */
export function describeRunState(run: { status: ExecutionStatus; errorCode?: string | null }): RunStateDescription {
  if (run.errorCode === ERROR_CODES.EXECUTION_INTERRUPTED) return { label: 'Interrupted', detail: 'The run stopped when the app restarted.' };
  if (run.errorCode === ERROR_CODES.EXECUTION_STOPPED_ON_SHUTDOWN) return { label: 'Stopped when the app closed', detail: 'Run it again to retry.' };
  switch (run.status) {
    case 'pending': return { label: 'Starting', detail: null };
    case 'generating': return { label: 'Writing code', detail: null };
    case 'verifying': return { label: 'Checking the code', detail: null };
    case 'executing': return { label: 'Running on your file', detail: null };
    case 'waiting': return { label: 'Waiting for your answer', detail: null };
    case 'awaiting_approval': return { label: 'Waiting for your go-ahead', detail: null };
    case 'awaiting_review': return { label: 'Waiting for your review', detail: null };
    case 'completed': return { label: 'Done', detail: null };
    case 'failed': return { label: "Didn't finish", detail: null };
    case 'aborted': return { label: 'Cancelled', detail: null };
    case 'rejected': return { label: "You said this wasn't right", detail: null };
    default: return run.status satisfies never;
  }
}

/**
 * Explain why a run appears in a task's timeline.
 * @param trigger Recorded run trigger.
 * @param options Whether the person supplied guidance.
 * @returns Timeline wording.
 * @example describeTrigger('rerun', { hasGuidance: true })
 */
export function describeTrigger(trigger: ExecutionTrigger, options: { hasGuidance: boolean; reuseKind?: ReuseKind | null }): string {
  if (options.reuseKind === 'run') return 'Ran your saved task';
  if (options.reuseKind === 'replay') return 'Ran again exactly';
  if (options.reuseKind === 'repair') return 'Repaired with AI';
  switch (trigger) {
    case 'manual': return 'First run';
    case 'rerun': return options.hasGuidance ? 'Tried again with your guidance' : 'Tried again';
    case 'feedback': return 'Re-run after your review';
    default: return trigger satisfies never;
  }
}

/**
 * Name the action a parked run needs from the person.
 * @param status A status waiting on the person.
 * @returns Action wording.
 * @example describeNeedsYou('awaiting_review') // 'Review the result'
 */
export function describeNeedsYou(status: 'waiting' | 'awaiting_approval' | 'awaiting_review'): string {
  switch (status) {
    case 'waiting': return 'Answer a question';
    case 'awaiting_approval': return 'Approve the run';
    case 'awaiting_review': return 'Review the result';
    default: return status satisfies never;
  }
}
