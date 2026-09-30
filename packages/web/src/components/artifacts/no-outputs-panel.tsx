// ---------------------------------------------------------------------------
// When there is nothing (or not enough) to show (FEAT-109 TASK-010, plan §6).
//
// `describeRunOutcome` decides the words; this panel renders them as a
// headline, a detail line, and next steps — and every next step is a CONTROL
// that exists on this screen. A step a person cannot act on from here is not a
// next step, so each action below has exactly one control. A limit breach is
// FEAT-108's `describeLimitBreach` sentence, verbatim, on its own line. No
// stack trace, no exit code as a headline, no path: the exit code stays in the
// run detail above for whoever wants it.
// ---------------------------------------------------------------------------

import type { ReactNode } from 'react';
import { describeRunOutcome, type ArtifactListResponse, type NextStep, type ScriptRun } from '@automate/core';
import { artifactArchiveUrl, artifactDownloadUrl } from '../../api/artifact-queries';
import { ds } from '../../design-system/tokens';

export interface NoOutputsPanelProps {
  readonly run: ScriptRun;
  readonly artifacts: ArtifactListResponse | undefined;
  readonly reviewing?: boolean;
  /** Stop a run that is still going. */
  readonly onCancel?: () => void;
}

/** Whether a settled run needs the panel: no outputs, a limit, a mismatch, or anything but success. */
export function needsOutcomePanel(run: ScriptRun, artifacts: ArtifactListResponse | undefined): boolean {
  if (run.status === 'running') return false;
  const missing = artifacts?.discrepancies.some((entry) => entry.kind === 'missing') ?? false;
  return run.status !== 'succeeded' || run.limitBreached !== null || missing || (artifacts?.artifacts.length ?? 0) === 0;
}

/** The one control for each next step. */
export function NextStepControl({ step, artifacts, executionId, reviewing = false, onCancel }: { step: NextStep; artifacts?: ArtifactListResponse; executionId: number; reviewing?: boolean; onCancel?: () => void }): ReactNode {
  switch (step.action) {
    case 'review_result': return <a className={ds.btnGhost} href="#review">{step.label}</a>;
    case 'download_produced': {
      const only = artifacts?.artifacts.length === 1 ? artifacts.artifacts[0] : undefined;
      return <a className={ds.btnGhost} href={only ? artifactDownloadUrl(only.id) : artifactArchiveUrl(executionId)} download>{step.label}</a>;
    }
    case 'retry_with_detail':
    case 'adjust_request': return <a className={ds.btnGhost} href={reviewing ? '#review' : '#run-again'}>{step.label}</a>;
    case 'open_transcript': return <a className={ds.btnGhost} href="#transcript">{step.label}</a>;
    case 'open_checks': return <a className={ds.btnGhost} href="#checks" onClick={() => { const panel = document.getElementById('run-record-details') as HTMLDetailsElement | null; const checks = document.getElementById('checks') as HTMLDetailsElement | null; if (panel) panel.open = true; if (checks) { checks.open = true; checks.scrollIntoView?.(); checks.focus(); } }}>{step.label}</a>;
    case 'prepare_runtime': return <a className={ds.btnGhost} href="/settings">{step.label}</a>;
    case 'cancel': return <button type="button" className={ds.btnGhost} onClick={onCancel} disabled={!onCancel}>{step.label}</button>;
  }
}

export function NoOutputsPanel(props: NoOutputsPanelProps) {
  const { run, artifacts } = props;
  const missing = artifacts?.discrepancies.find((entry) => entry.kind === 'missing')?.count ?? 0;
  const outcome = describeRunOutcome({ status: run.status, exitCode: run.exitCode, limitBreached: run.limitBreached, manifestPresent: run.manifestPresent, declaredOutputCount: run.declaredOutputCount, missingDeclaredCount: missing }, artifacts?.artifacts ?? []);
  return (
    <section className={outcome.tone === 'problem' ? ds.noOutputsProblem : ds.noOutputsPanel} aria-label="What happened, and what to do next">
      <h3 className={ds.sectionTitle}>{outcome.headline}</h3>
      {outcome.limit ? <p>{outcome.limit}</p> : null}
      {outcome.detail ? <p>{outcome.detail}</p> : null}
      <ul className={ds.nextStepList} aria-label="Next steps">
        {outcome.nextSteps.map((step) => <li key={step.action}><NextStepControl step={step} artifacts={artifacts} executionId={run.executionId} reviewing={props.reviewing} onCancel={props.onCancel} /></li>)}
      </ul>
    </section>
  );
}
