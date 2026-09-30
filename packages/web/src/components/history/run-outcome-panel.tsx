import { useEffect, useRef, type ReactNode } from 'react';
import type { ArtifactListResponse, RunFailure } from '@automate/core';
import { ds } from '../../design-system/tokens';
import { NextStepControl } from '../artifacts/no-outputs-panel';
import { useShowTechnical } from './use-technical-details';

/** One readable outcome and one place to start the next run. */
export function RunOutcomePanel({ failure, retry, reviewing, executionId, artifacts }: { failure: RunFailure; retry: ReactNode; reviewing: boolean; executionId: number; artifacts?: ArtifactListResponse }) {
  const technical = useShowTechnical();
  const retryRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const focus = () => { if (window.location.hash === '#run-again') retryRef.current?.focus(); };
    window.addEventListener('hashchange', focus);
    focus();
    return () => window.removeEventListener('hashchange', focus);
  }, []);
  return <section className={failure.tone === 'problem' ? ds.noOutputsProblem : ds.noOutputsPanel} aria-label="What happened, and what to do next">
    <h3 className={ds.sectionTitle}>{failure.headline}</h3>
    {failure.limit ? <p>{failure.limit}</p> : null}
    {failure.detail ? <p>{failure.detail}</p> : null}
    {failure.attempts.length ? <ul className={ds.noteList}>{failure.attempts.map((attempt, index) => <li key={index} className={ds.noteItem}>{attempt}</li>)}</ul> : null}
    <ul className={ds.nextStepList} aria-label="Next steps">{failure.nextSteps.map((step) => <li key={step.action}><NextStepControl step={step} artifacts={artifacts} executionId={executionId} reviewing={reviewing} /></li>)}</ul>
    {technical && failure.technical.code ? <p>Code: <code>{failure.technical.code}</code></p> : null}
    {technical && failure.technical.correlationId ? <p>Correlation ID: <code>{failure.technical.correlationId}</code> <button className={ds.btnSmall} onClick={() => void navigator.clipboard?.writeText(failure.technical.correlationId ?? '')}>Copy</button></p> : null}
    {!reviewing ? <div ref={retryRef} id="run-again" tabIndex={-1}>{retry}</div> : null}
  </section>;
}
