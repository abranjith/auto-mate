import type { ExecutionSummary } from '@automate/core';
import { RunControls } from './run-controls';
import { ds } from '../../design-system/tokens';
export function WaitingBanner({ execution }: { execution: ExecutionSummary }) {
  if (execution.status !== 'waiting') return null;
  return <aside className={ds.waitingBanner}><p>This run is waiting for your answer. It does not occupy an execution slot.</p><RunControls execution={execution} /></aside>;
}
