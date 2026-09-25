import { useState } from 'react';
import { AutoMateError, ERROR_CODES, RUN_INTENT_CAVEATS, formatBytes, type ApprovalResponse, type RunIntentResponse } from '@automate/core';
import { ds } from '../../design-system/tokens';
import { looksLikeFormula } from '../ingestion/sample-rows-table';
import { RuntimeNote } from './runtime-note';

/** Model- or script-written text, shown literally; formula-like text is marked, never interpreted. */
export function UntrustedText({ value }: { value: string }) {
  return looksLikeFormula(value) ? <span className={ds.formulaLike} title="Shown as text. It is not run as a formula.">{value}</span> : <>{value}</>;
}

export interface RunIntentPanelProps {
  readonly data: RunIntentResponse;
  /** Send the decision with the digest of exactly what is shown. */
  readonly onDecide: (decision: 'approved' | 'cancelled', acknowledgedWarnings: boolean) => Promise<ApprovalResponse>;
  /** The page is out of date: fetch the intent again. */
  readonly onStale: () => void;
}

function testsLine(tests: RunIntentResponse['intent']['tests']): string | null {
  if (tests.total === null || tests.passed === null) return null;
  const rows = tests.fixtureRowCount === null ? '' : ` against ${tests.fixtureRowCount} synthetic rows`;
  return `${tests.passed} of ${tests.total} tests passed${rows}.`;
}

/**
 * The approval gate: what will be read, what the script says it will write,
 * what was checked, what it was checked against, and the caveats that are
 * true — then **Run it** or **Cancel**. Nothing runs until a person chooses.
 */
export function RunIntentPanel({ data, onDecide, onStale }: RunIntentPanelProps) {
  const { intent } = data;
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string>();
  const [changes, setChanges] = useState<readonly string[]>();
  const warnings = intent.advisoryCount;
  const decide = async (decision: 'approved' | 'cancelled') => {
    setPending(true); setMessage(undefined);
    try {
      const response = await onDecide(decision, acknowledged);
      if (response.outcome === 'reverify') setChanges(response.runtimeChanges);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'The decision could not be saved.');
      if (cause instanceof AutoMateError && cause.code === ERROR_CODES.APPROVAL_INTENT_MISMATCH) { setAcknowledged(false); onStale(); }
    } finally { setPending(false); }
  };
  const tests = testsLine(intent.tests);
  return (
    <section className={ds.gatePanel} aria-label="Review before running">
      <h2 className={ds.sectionTitle}>Ready to run on your file</h2>
      {intent.summary ? <p><UntrustedText value={intent.summary} /></p> : null}
      <div className={ds.stackTight}>
        <h3 className={ds.label}>It will read</h3>
        <ul className={ds.gateList}>{intent.inputs.map((input) => <li key={input.uploadId}>{input.originalFilename} ({formatBytes(input.byteSize)}{input.sheets.length ? `; sheets: ${input.sheets.join(', ')}` : ''})</li>)}</ul>
      </div>
      <div className={ds.stackTight}>
        <h3 className={ds.label}>It says it will write</h3>
        <ul className={ds.gateList}>{intent.outputs.map((output) => <li key={output.filename}>{output.filename} ({output.type}) — <UntrustedText value={output.title} />{output.description ? <>: <UntrustedText value={output.description} /></> : null}</li>)}</ul>
      </div>
      <div className={ds.stackTight}>
        <h3 className={ds.label}>What was checked</h3>
        <p className={intent.blockingCount === 0 ? ds.verdictPassed : ds.verdictBlocked}>{intent.verdict}</p>
        {tests ? <p className={ds.hint}>{tests}</p> : null}
      </div>
      <RuntimeNote description={intent.runtime.description} {...(changes ? { changes } : {})} />
      <ul className={ds.caveatList} aria-label="Before you run">{RUN_INTENT_CAVEATS.map((caveat) => <li key={caveat} className={ds.caveat}>{caveat}</li>)}</ul>
      {warnings > 0 ? (
        <label className={ds.checkboxRow}>
          <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
          <span>I have read the {warnings} advisory finding{warnings === 1 ? '' : 's'} in the report above.</span>
        </label>
      ) : null}
      {message ? <p className={ds.statusDanger} role="alert">{message}</p> : null}
      <div className={ds.row}>
        <button type="button" className={ds.btnPrimary} disabled={pending || changes !== undefined || (warnings > 0 && !acknowledged)} onClick={() => void decide('approved')}>Run it</button>
        <button type="button" className={ds.btnGhost} disabled={pending} onClick={() => void decide('cancelled')}>Cancel</button>
      </div>
    </section>
  );
}
