import type { ConnectionTestResponse } from '@automate/core';
import { ds } from '../../design-system/tokens';

/** Props for {@link ConnectionTest}. */
export interface ConnectionTestProps {
  /** True while a test session is open. */
  readonly pending: boolean;
  /** True when the form has edits that the test would not use. */
  readonly dirty: boolean;
  /** The last test outcome, if one has run. */
  readonly result: ConnectionTestResponse | undefined;
  /** A plain-English failure from the request itself, as opposed to the session. */
  readonly errorMessage?: string;
  /** Start a test. */
  readonly onTest: () => void;
}

/** Summarize the normalized events a successful test produced. */
function summarize(counts: Readonly<Record<string, number>>): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) return 'no events';
  return entries.map(([type, count]) => `${count} ${type}`).join(', ');
}

/**
 * The Test connection control and its result.
 *
 * A failure renders as the plain-English message the server sent, never a stack
 * trace. The test always uses the SAVED selection, so the button says as much
 * when the form has unsaved edits.
 *
 * @param props See {@link ConnectionTestProps}.
 * @returns The test panel.
 * @example <ConnectionTest pending={false} dirty={false} result={result} onTest={run} />
 */
export function ConnectionTest(props: ConnectionTestProps) {
  return <section className={ds.card} aria-labelledby="connection-test-heading">
    <h2 id="connection-test-heading" className={ds.sectionTitle}>Test connection</h2>
    <div className={ds.stack}>
      <p className={ds.hint}>
        Opens one real agent session with the saved selection, calls a single <code>status</code> tool, and closes. It sends no
        file data — only a short built-in prompt.
      </p>
      <div className={ds.row}>
        <button type="button" className={ds.btnPrimary} disabled={props.pending} onClick={props.onTest}>
          {props.pending ? 'Testing…' : 'Test connection'}
        </button>
        {props.dirty ? <span className={ds.statusMuted}>Save your changes first — the test uses the saved selection.</span> : null}
      </div>

      {props.errorMessage === undefined ? null : <p className={ds.statusDanger} role="alert">{props.errorMessage}</p>}

      {props.result === undefined || props.pending ? null : props.result.ok
        ? <div className={ds.stackTight}>
            <p className={ds.statusSuccess} role="status">
              ✓ Connected to {props.result.provider} / {props.result.model} in {props.result.durationMs} ms.
            </p>
            <p className={ds.hint}>
              Credential source: {props.result.authSource ?? 'unknown'}. The status tool was
              {props.result.statusToolInvoked ? ' called and returned' : ' not called'}. Events: {summarize(props.result.eventCounts)}.
            </p>
          </div>
        : <div className={ds.stackTight}>
            <p className={ds.statusDanger} role="alert">✗ {props.result.error?.message ?? 'The test session did not complete.'}</p>
            {props.result.error === undefined ? null : <p className={ds.hint}>Error code: {props.result.error.code}</p>}
          </div>}
    </div>
  </section>;
}
