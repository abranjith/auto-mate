import { useQueryClient } from '@tanstack/react-query';
import {
  AutoMateError,
  ERROR_CODES,
  isTerminal,
  type ExecutionSummary,
} from '@automate/core';
import { useAbortExecution } from '../../api/task-queries';
import { ds } from '../../design-system/tokens';
/** Cancellation control for a non-terminal execution. */
export function RunControls({ execution }: { execution: ExecutionSummary }) {
  const mutation = useAbortExecution(execution.id);
  const client = useQueryClient();
  if (isTerminal(execution.status)) return null;
  const notRunning =
    mutation.error instanceof AutoMateError &&
    mutation.error.code === ERROR_CODES.EXECUTION_NOT_RUNNING;
  return (
    <div className={ds.stackTight}>
      <button
        type="button"
        className={ds.btnGhost}
        disabled={mutation.isPending}
        onClick={() =>
          mutation.mutate(undefined, {
            onError: (error) => {
              if (error.code === ERROR_CODES.EXECUTION_NOT_RUNNING)
                void client.invalidateQueries({
                  queryKey: ['execution', execution.id],
                });
            },
          })
        }
      >
        {mutation.isPending ? 'Aborting…' : 'Cancel run'}
      </button>
      {mutation.isError ? (
        <p className={ds.statusDanger} role="alert">
          {notRunning
            ? 'This run has already finished. Refreshing its status…'
            : mutation.error.message}
        </p>
      ) : null}
    </div>
  );
}

/** Optional provider-reported completion metrics. */
export function CompletedSummary({
  execution,
}: {
  execution: ExecutionSummary;
}) {
  if (execution.status !== 'completed') return null;
  const parts = [
    execution.durationMs === null ? undefined : `${execution.durationMs} ms`,
    execution.usage.turns === undefined
      ? undefined
      : `${execution.usage.turns} turns`,
    execution.usage.costUsd === undefined
      ? undefined
      : `$${execution.usage.costUsd.toFixed(4)}`,
  ].filter(Boolean);
  return (
    <p className={ds.eventLine}>
      Completed{parts.length ? ` · ${parts.join(' · ')}` : ''}
    </p>
  );
}
