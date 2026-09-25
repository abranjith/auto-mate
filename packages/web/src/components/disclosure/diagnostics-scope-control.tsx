import { ds } from '../../design-system/tokens';
export const DIAGNOSTIC_EXAMPLE = 'ValueError: could not convert string to float: <str len=21>';
export function DiagnosticsScopeControl({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return <label className={ds.listItem}><span className={ds.row}><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />Allow filtered diagnostics for automatic repair</span><pre className={ds.codeBlock}>{DIAGNOSTIC_EXAMPLE}</pre><span className={ds.hint}>Unrecognized lines are dropped; quoted values are replaced by their length.</span></label>;
}
