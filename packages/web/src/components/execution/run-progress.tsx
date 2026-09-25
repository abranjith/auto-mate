import { formatDurationMs, type ExecutionSummary } from '@automate/core';
import { useAbortExecution } from '../../api/task-queries';
import { ds } from '../../design-system/tokens';

/** The honest line: what is running, where, and with what access. */
export const RUN_ACCESS_NOTICE = 'This is running on your computer with the same access this application has.';

/** While the approved script runs: elapsed time, the honest access line, and a way to stop it. */
export function RunProgress({ execution, now, onCancel }: { execution: ExecutionSummary; now: number; onCancel?: () => void }) {
  const abort = useAbortExecution(execution.id);
  const started = execution.startedAt ? Date.parse(execution.startedAt) : now;
  return (
    <div className={ds.runProgress} role="status" aria-live="polite">
      <p>Running the script on a copy of your file… {formatDurationMs(Math.max(0, now - started))} so far.</p>
      <p className={ds.hint}>{RUN_ACCESS_NOTICE}</p>
      <div className={ds.row}>
        <button type="button" className={ds.btnGhost} disabled={abort.isPending} onClick={() => { onCancel?.(); abort.mutate(); }}>{abort.isPending ? 'Stopping…' : 'Stop the run'}</button>
      </div>
      {abort.isError ? <p className={ds.statusDanger} role="alert">{abort.error.message}</p> : null}
    </div>
  );
}
