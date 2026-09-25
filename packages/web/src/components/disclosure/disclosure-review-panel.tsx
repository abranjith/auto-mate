import { useState } from 'react';
import type { DisclosurePreviewResponse, PreflightDecision } from '@automate/core';
import { ds } from '../../design-system/tokens';
import { AppliedDefaultsList } from './applied-defaults-list';
import { DiagnosticsScopeControl } from './diagnostics-scope-control';
import { DisclosurePayloadView } from './disclosure-payload-view';
import { PreflightDecisions } from './preflight-decisions';
import { RecipientBadge } from './recipient-badge';

export function DisclosureReviewPanel({ preview, pending, error, onApprove, onRefresh, onCancel }: { preview: DisclosurePreviewResponse; pending: boolean; error?: string; onApprove: (value: { diagnostics: boolean; decisions: readonly PreflightDecision[]; defaults: Readonly<Record<string, string>> }) => void; onRefresh: () => void; onCancel: () => void }) {
  const [diagnostics, setDiagnostics] = useState(true);
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  const complete = preview.required.every(({ findingKey }) => decisions[findingKey] !== undefined);
  const rows = preview.text.split('\n').filter((line) => line.startsWith('Rows:')).length;
  return <section className={ds.disclosurePanel} aria-label="Disclosure review"><h2>Review what will leave this machine</h2><p>{preview.byteSize.toLocaleString()} bytes describing {preview.uploadIds.length} file{preview.uploadIds.length === 1 ? '' : 's'} and {rows} table{rows === 1 ? '' : 's'}.</p><RecipientBadge provider={preview.provider} model={preview.model} /><DisclosurePayloadView text={preview.text} byteSize={preview.byteSize} />{preview.truncations.map((note) => <p className={ds.hint} key={note}>{note} was omitted to keep the description bounded.</p>)}<PreflightDecisions findings={preview.required} values={decisions} onChange={(key, value) => setDecisions((current) => ({ ...current, [key]: value }))} /><AppliedDefaultsList defaults={preview.defaults} values={defaults} onChange={(key, value) => setDefaults((current) => ({ ...current, [key]: value }))} /><DiagnosticsScopeControl checked={diagnostics} onChange={setDiagnostics} />{error ? <p role="alert" className={ds.statusDanger}>{error}</p> : null}<div className={ds.row}><button className={ds.btnPrimary} type="button" disabled={!complete || pending} onClick={() => onApprove({ diagnostics, decisions: Object.entries(decisions).map(([findingKey, choice]) => ({ findingKey, choice })), defaults })}>{pending ? 'Starting…' : 'Approve and start'}</button><button className={ds.btnGhost} type="button" onClick={onCancel}>Back</button>{error ? <button className={ds.btnGhost} type="button" onClick={onRefresh}>Refresh preview</button> : null}</div></section>;
}
