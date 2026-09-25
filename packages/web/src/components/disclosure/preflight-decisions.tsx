import type { DisclosurePreviewResponse } from '@automate/core';
import { ds } from '../../design-system/tokens';
type Finding = DisclosurePreviewResponse['required'][number];
export function PreflightDecisions({ findings, values, onChange }: { findings: readonly Finding[]; values: Readonly<Record<string, string>>; onChange: (key: string, value: string) => void }) {
  return <fieldset className={ds.stackTight}><legend className={ds.label}>Decisions required before starting</legend>{findings.map((finding) => <div className={ds.listItem} key={finding.findingKey}><p>{finding.question}</p><p className={ds.hint}>{finding.rationale}</p>{finding.options.map((item) => <label className={ds.row} key={item.value}><input type="radio" name={finding.findingKey} value={item.value} checked={values[finding.findingKey] === item.value} onChange={() => onChange(finding.findingKey, item.value)} />{item.label}</label>)}<p className={ds.hint}>If ignored, the default would be: {finding.proposedDefault}</p></div>)}</fieldset>;
}
