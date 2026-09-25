import type { DisclosurePreviewResponse } from '@automate/core';
import { ds } from '../../design-system/tokens';
type Default = DisclosurePreviewResponse['defaults'][number];
export function AppliedDefaultsList({ defaults, values, onChange }: { defaults: readonly Default[]; values: Readonly<Record<string, string>>; onChange: (key: string, value: string) => void }) {
  if (!defaults.length) return null;
  return <section><h3>Decisions Auto-Mate applied</h3><ul className={ds.listPlain}>{defaults.map((item) => <li className={ds.listItem} key={item.findingKey}><label><span>{item.label}: </span>{item.options?.length ? <select className={ds.select} value={values[item.findingKey] ?? item.value} onChange={(event) => onChange(item.findingKey, event.target.value)}>{item.options.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select> : <input className={ds.input} aria-label={`${item.label} override`} value={values[item.findingKey] ?? item.value} onChange={(event) => onChange(item.findingKey, event.target.value)} />}</label></li>)}</ul></section>;
}
