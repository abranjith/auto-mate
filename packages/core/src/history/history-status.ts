import { PARKED_STATUSES, type ExecutionStatus } from '../conversation/execution-state';

/** The four filters shown in History; every execution status belongs to one. */
export const HISTORY_STATUS_GROUPS = {
  needs_you: PARKED_STATUSES,
  running: ['pending', 'generating', 'verifying', 'executing'],
  done: ['completed'],
  stopped: ['failed', 'aborted', 'rejected'],
} as const satisfies Record<string, readonly ExecutionStatus[]>;
export type HistoryStatusGroup = keyof typeof HISTORY_STATUS_GROUPS;

/**
 * Return the History filter for an execution state.
 * @param status Persisted execution state.
 * @returns Its single History group.
 * @example statusGroupOf('waiting') // 'needs_you'
 */
export function statusGroupOf(status: ExecutionStatus): HistoryStatusGroup {
  switch (status) {
    case 'waiting':
    case 'awaiting_approval':
    case 'awaiting_review': return 'needs_you';
    case 'pending':
    case 'generating':
    case 'verifying':
    case 'executing': return 'running';
    case 'completed': return 'done';
    case 'failed':
    case 'aborted':
    case 'rejected': return 'stopped';
    default: return status satisfies never;
  }
}
