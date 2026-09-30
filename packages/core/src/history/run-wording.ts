// This module is the single source of the plain-English wording in History.
import { ERROR_CODES } from '../errors/error-codes';
import type { ExecutionStatus } from '../conversation/execution-state';
import type { ReuseKind } from '../reuse/reuse-kind';
import type { RunTimelineItem } from '../contracts/history-api';

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
 * Shorten a person's reason for display on a run connector.
 * @param text The original reason, if one was provided.
 * @param max Maximum displayed characters, including the ellipsis.
 * @returns One line of text, or null for empty input.
 * @example excerptReason('use  the Total column') // 'use the Total column'
 */
export function excerptReason(text: string | null, max = 140): string | null {
  const clean = text?.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  if (clean.length <= max) return clean;
  const prefix = clean.slice(0, max - 1);
  const space = prefix.lastIndexOf(' ');
  return `${space > 0 ? prefix.slice(0, space) : prefix}…`;
}

/**
 * Describe why a later run follows its predecessor.
 * @param item The later run's trigger and recorded reason.
 * @returns A label and optional verbatim excerpt.
 * @example describeLineageEdge({ trigger: 'rerun', hasGuidance: true, reason: 'Use totals', reuse: null })
 */
export function describeLineageEdge(item: Pick<RunTimelineItem, 'trigger' | 'hasGuidance' | 'reason' | 'reuse'>): { label: string; quote: string | null } {
  const label = describeTrigger(item.trigger, { hasGuidance: item.hasGuidance, reuseKind: item.reuse?.kind });
  const quote = item.trigger === 'manual' || item.reuse?.kind === 'replay' ? null : item.reason;
  return { label, quote };
}

/**
 * Explain where the first run of a task came from, when a saved task was used.
 * @param reuse The saved-task origin, if any.
 * @returns A readable origin sentence, or null for a plain run or replay.
 * @example describeLineageOrigin({ kind: 'run', templateId: 7, templateName: 'Sales', revisionNumber: 2 })
 */
export function describeLineageOrigin(reuse: RunTimelineItem['reuse']): string | null {
  if (!reuse || reuse.kind === 'replay') return null;
  const source = reuse.templateId === null ? 'a saved task since deleted' : `“${reuse.templateName}” (revision ${reuse.revisionNumber})`;
  return reuse.kind === 'repair' ? `Repaired ${source} for another file` : `Ran ${source} with another file`;
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
