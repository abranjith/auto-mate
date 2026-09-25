import { describeLimitBreach, formatBytes, type ScriptRun } from '@automate/core';
import { ds } from '../../design-system/tokens';
import { UntrustedText } from '../verification/run-intent-panel';

/** An honest absence, rather than a dead control. */
export const OUTPUTS_ARRIVE_LATER = 'Viewing and downloading these files arrives with the next feature; for now they are listed here by name.';

const TAIL_LINES = 40;

/** How the run ended, in words. */
export function describeRunStatus(run: Pick<ScriptRun, 'status' | 'exitCode'>): string {
  switch (run.status) {
    case 'succeeded': return 'The script finished and produced everything it said it would.';
    case 'failed': return run.exitCode === 0 ? 'The script finished, but its outputs do not match what it declared.' : `The script stopped with an error (exit code ${run.exitCode ?? 'unknown'}).`;
    case 'timed_out': return 'The script ran too long and was stopped.';
    case 'aborted': return 'The run was stopped.';
    case 'errored': return 'The script could not be started.';
    default: return 'The script is running.';
  }
}

/** The last lines of captured output. It may contain values from your file; it is shown as text only. */
function tail(text: string | null): string {
  if (!text) return '';
  return text.split(/\r?\n/).slice(-TAIL_LINES).join('\n');
}

/** A settled run: the outcome, the declared outputs with type and size, and the tail of its output. */
export function RunResult({ run }: { run: ScriptRun }) {
  const output = [tail(run.stdout), tail(run.stderr)].filter(Boolean).join('\n');
  return (
    <section className={ds.runResult} aria-label="Run result">
      <p className={run.status === 'succeeded' ? ds.verdictPassed : ds.verdictBlocked}>{describeRunStatus(run)}</p>
      {run.limitBreached ? <p className={ds.statusDanger}>{describeLimitBreach(run.limitBreached)}</p> : null}
      {run.outputByteCount !== null ? <p className={ds.hint}>Output files used {formatBytes(run.outputByteCount)}.</p> : null}
      {run.declaredOutputs.length > 0 ? (
        <div className={ds.stackTight}>
          <h3 className={ds.label}>What it produced</h3>
          <ul className={ds.gateList}>
            {run.declaredOutputs.map((item) => (
              <li key={item.filename}>
                {item.filename} ({item.type}{item.byteSize === null ? ', not written' : `, ${formatBytes(item.byteSize)}`}) — <UntrustedText value={item.title} />{item.description ? <>: <UntrustedText value={item.description} /></> : null}
              </li>
            ))}
          </ul>
          <p className={ds.hint}>{OUTPUTS_ARRIVE_LATER}</p>
        </div>
      ) : null}
      {output ? (
        <details>
          <summary className={ds.codeCardSummary}>Show the script's output</summary>
          <pre className={ds.outputTail}>{output}</pre>
        </details>
      ) : null}
      {run.outputTruncated ? <p className={ds.hint}>The output was long, so only its beginning and end were kept.</p> : null}
    </section>
  );
}
