import type { ExecutionStatus } from '@automate/core';
import { ds } from '../../design-system/tokens';
const labels: Record<ExecutionStatus, string> = {
  pending: 'Pending',
  generating: 'Generating',
  verifying: 'Verifying',
  executing: 'Executing',
  waiting: 'Waiting',
  completed: 'Completed',
  failed: 'Failed',
  aborted: 'Cancelled',
};
/** Visible and announced execution-state label. */
export function ExecutionStatusBadge({ status }: { status: ExecutionStatus }) {
  return (
    <span className={ds.badge} role="status" aria-live="polite">
      {labels[status]}
    </span>
  );
}
