import { MAX_MAPPING_NOTE_CHARS, describeColumnType, type CompatibilityReport, type RepairMapping, type UploadResponse } from '@automate/core';
import { ds } from '../../design-system/tokens';

export function initialMapping(report: CompatibilityReport): RepairMapping {
  return {
    columns: report.findings.filter((item) => item.code === 'column_missing').map((item) => ({ inputPosition: item.inputPosition, sheet: item.sheet, expected: item.column ?? '', use: item.suggestion ?? null })),
    sheets: report.findings.filter((item) => item.code === 'sheet_missing').map((item) => ({ inputPosition: item.inputPosition, expected: item.sheet ?? '', use: null })),
    decisions: report.findings.filter((item) => item.code === 'decision_unrecorded' || item.code === 'rule_conflict').map((item) => { const finding = item.finding as { findingKey: string; proposedDefault?: string; options?: { value: string }[] } | undefined; return { findingKey: finding?.findingKey ?? '', answer: finding?.proposedDefault ?? finding?.options?.[0]?.value ?? '' }; }),
    note: null,
  };
}

/** Explicit choices for every blocking column, sheet, and decision. */
export function MappingForm({ report, uploads, value, onChange }: { report: CompatibilityReport; uploads: readonly (UploadResponse | null)[]; value: RepairMapping; onChange: (next: RepairMapping) => void }) {
  const updateColumn = (index: number, use: string | null) => onChange({ ...value, columns: value.columns.map((item, position) => position === index ? { ...item, use } : item) });
  const updateSheet = (index: number, use: string | null) => onChange({ ...value, sheets: value.sheets.map((item, position) => position === index ? { ...item, use } : item) });
  const updateDecision = (index: number, answer: string) => onChange({ ...value, decisions: value.decisions.map((item, position) => position === index ? { ...item, answer } : item) });
  const decisions = report.findings.filter((item) => item.code === 'decision_unrecorded' || item.code === 'rule_conflict');
  const expectedType = (item: RepairMapping['columns'][number]) => report.findings.find((finding) => finding.code === 'column_missing' && finding.inputPosition === item.inputPosition && finding.sheet === item.sheet && finding.column === item.expected)?.expected ?? null;
  return <section className={ds.card}><h2 className={ds.sectionTitle}>How should the task adapt?</h2>
    {value.columns.map((item, index) => { const table = uploads[item.inputPosition]?.profiles.find((entry) => entry.sheetName === item.sheet) ?? uploads[item.inputPosition]?.profiles[0]; return <label key={`column-${index}`} className={ds.field}>The saved task used a column called “{item.expected}”{expectedType(item) ? ` (${describeColumnType(expectedType(item)!)})` : ''} in file {item.inputPosition + 1}{item.sheet ? ` › ${item.sheet}` : ''}. Which column in your new file holds the same thing?
      <select className={ds.input} value={item.use ?? ''} onChange={(event) => updateColumn(index, event.target.value || null)}><option value="">None — it isn't in this file</option>{table?.columns.map((column) => <option key={column.position} value={column.name}>{column.name}</option>)}</select></label>; })}
    {value.sheets.map((item, index) => <label key={`sheet-${index}`} className={ds.field}>Which worksheet replaces “{item.expected}” in file {item.inputPosition + 1}?
      <select className={ds.input} value={item.use ?? ''} onChange={(event) => updateSheet(index, event.target.value || null)}><option value="">None — it isn't in this file</option>{uploads[item.inputPosition]?.profiles.map((table) => <option key={table.sheetIndex} value={table.sheetName ?? ''}>{table.sheetName}</option>)}</select></label>)}
    {value.decisions.map((item, index) => { const finding = decisions[index]?.finding as { question?: string; options?: { value: string; label: string }[] } | undefined; return <label key={`decision-${index}`} className={ds.field}>{finding?.question ?? 'Which interpretation should be used?'}
      <select className={ds.input} value={item.answer} onChange={(event) => updateDecision(index, event.target.value)}>{finding?.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>; })}
    <label className={ds.field}>Anything else the AI should know?<textarea className={ds.textarea} value={value.note ?? ''} maxLength={MAX_MAPPING_NOTE_CHARS} onChange={(event) => onChange({ ...value, note: event.target.value || null })} /></label>
  </section>;
}
