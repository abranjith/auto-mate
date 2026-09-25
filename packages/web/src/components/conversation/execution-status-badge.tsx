import type { ExecutionStatus } from '@automate/core';
import { ds } from '../../design-system/tokens';
const labels: Record<ExecutionStatus, string> = {
  pending: 'Pending',
  generating: 'Generating',
  verifying: 'Checking the code',
  awaiting_approval: 'Waiting for your approval',
  executing: 'Running on your file',
  awaiting_review: 'Waiting for your review',
  waiting: 'Waiting',
  completed: 'Completed',
  failed: 'Failed',
  aborted: 'Cancelled',
  rejected: 'Rejected — retrying',
};
/** Visible and announced execution-state label. */
export function ExecutionStatusBadge({ status }: { status: ExecutionStatus }) {
  return (
    <span className={ds.badge} role="status" aria-live="polite">
      {labels[status]}
    </span>
  );
}
