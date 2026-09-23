import type { ExecutionSummary } from '@automate/core';
import { ds } from '../../design-system/tokens';
/** Render safe persisted failure details and never internal diagnostics. */
export function FailurePanel({
  error,
}: {
  error: NonNullable<ExecutionSummary['error']>;
}) {
  const interrupted = error.code === 'EXECUTION_INTERRUPTED';
  const copy = interrupted
    ? 'The server restarted during this run. Start the task again to retry.'
    : error.message;
  return (
    <section className={ds.failurePanel} role="alert">
      <h2>Run failed</h2>
      <p>{copy}</p>
      <p>
        Code: <code>{error.code}</code>
      </p>
      {error.correlationId ? (
        <p>
          Correlation ID: <code>{error.correlationId}</code>{' '}
          <button
            type="button"
            className={ds.btnGhost}
            onClick={() =>
              void navigator.clipboard?.writeText(error.correlationId ?? '')
            }
          >
            Copy
          </button>
        </p>
      ) : null}
    </section>
  );
}
