import { ds } from '../../design-system/tokens';

const FILTERS = [['all', 'All'], ['needs_you', 'Needs you'], ['running', 'Running'], ['done', 'Done'], ['stopped', "Didn't finish"]] as const;
/** Search and status controls for History. */
export function HistoryFilters({ status, q, onStatus, onQuery }: { status: string; q: string; onStatus(value: string): void; onQuery(value: string): void }) {
  return <div className={ds.stackTight}>
    <label className={ds.field}><span className={ds.label}>Search your tasks</span><input className={ds.input} value={q} maxLength={200} onChange={(event) => onQuery(event.target.value)} /></label>
    <nav className={ds.row} aria-label="History filters">{FILTERS.map(([value, label]) => <button key={value} type="button" className={status === value ? ds.historyFilterActive : ds.btnGhost} aria-pressed={status === value} onClick={() => onStatus(value)}>{label}</button>)}</nav>
  </div>;
}
