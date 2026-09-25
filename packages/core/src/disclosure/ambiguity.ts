import type { ProfileNote, TableProfile } from '../contracts/upload-api';
import { MAX_PREFLIGHT_DECISIONS } from './limits';

export interface FindingOption { readonly value: string; readonly label: string }
export interface Finding {
  readonly findingKey: string;
  readonly impact: 'data_loss' | 'meaning';
  readonly question: string;
  readonly rationale: string;
  readonly options: readonly FindingOption[];
  readonly proposedDefault: string;
  readonly profileIndex: number;
  readonly columnPosition: number;
}
export interface AppliedDefault {
  readonly findingKey: string;
  readonly label: string;
  readonly value: string;
  readonly options?: readonly FindingOption[];
  readonly demoted: boolean;
}
export interface Notice { readonly findingKey: string; readonly text: string }

const option = (value: string, label = value): FindingOption => ({ value, label });
const key = (profileIndex: number, target: string | number, kind: string) => `${profileIndex}:${target}:${kind}`;
const noteFor = (profile: TableProfile, code: ProfileNote['code'], column?: string) =>
  profile.notes.find((note) => note.code === code && (column === undefined || note.column === column));

function noteFinding(profile: TableProfile, profileIndex: number, note: ProfileNote): Finding | undefined {
  const target = note.column ?? profile.sheetIndex;
  const findingKey = key(profileIndex, target, note.code);
  if (note.code === 'ambiguous_date_format') {
    const formats = note.formats?.slice(0, 2) ?? ['DD/MM', 'MM/DD'];
    return { findingKey, impact: 'meaning', question: `How should dates in ${note.column ?? 'this table'} be interpreted?`, rationale: 'Both day-first and month-first readings fit the sampled values.', options: formats.map((value) => option(value)), proposedDefault: formats[0] ?? 'DD/MM', profileIndex, columnPosition: profile.columns.findIndex((column) => column.name === note.column) };
  }
  if (note.code === 'no_header_detected') return { findingKey, impact: 'meaning', question: 'Does row 1 contain data or column headings?', rationale: 'Treating the first row as headings changes which values are analyzed.', options: [option('data', 'Row 1 is data'), option('header', 'Row 1 is a header')], proposedDefault: 'data', profileIndex, columnPosition: -1 };
  if (note.code === 'ragged_rows') return { findingKey, impact: 'data_loss', question: 'How should rows with a different number of fields be handled?', rationale: 'Skipping those rows can remove data.', options: [option('keep'), option('skip')], proposedDefault: 'keep', profileIndex, columnPosition: -1 };
  if (note.code === 'merged_cells') return { findingKey, impact: 'meaning', question: 'Should processing continue despite merged cells?', rationale: 'Merged cells can change how values relate to columns.', options: [option('continue'), option('stop')], proposedDefault: 'continue', profileIndex, columnPosition: -1 };
  return undefined;
}

function mixedFinding(profile: TableProfile, profileIndex: number, columnIndex: number): Finding | undefined {
  const column = profile.columns[columnIndex];
  if (!column?.isMixedType || column.valueCount === 0) return undefined;
  const offending = noteFor(profile, 'mixed_type_column', column.name)?.count ?? Math.max(0, column.valueCount - Math.round(column.valueCount * column.typeConfidence));
  if (offending / column.valueCount <= 0.01) return undefined;
  return { findingKey: key(profileIndex, column.name, 'mixed_type_column'), impact: 'meaning', question: `How should non-${column.inferredType} values in ${column.name} be handled?`, rationale: 'More than 1% of sampled values do not match the inferred type.', options: [option('text', 'Treat the column as text'), option('drop', 'Drop offending values'), option('stop', 'Stop')], proposedDefault: 'text', profileIndex, columnPosition: column.position };
}

function cosmeticDefaults(profile: TableProfile, profileIndex: number): AppliedDefault[] {
  const defaults: AppliedDefault[] = [];
  if (profile.delimiter) defaults.push({ findingKey: key(profileIndex, profile.sheetIndex, 'delimiter'), label: 'Detected delimiter', value: profile.delimiter, demoted: false });
  if (profile.dialect?.quoteChar) defaults.push({ findingKey: key(profileIndex, profile.sheetIndex, 'quote'), label: 'Detected quote character', value: profile.dialect.quoteChar, demoted: false });
  for (const note of profile.notes) {
    if (note.code === 'duplicate_headers_renamed') defaults.push({ findingKey: key(profileIndex, profile.sheetIndex, note.code), label: 'Renamed duplicate headings', value: 'renamed', demoted: false });
    if (note.code === 'encoding_guessed') defaults.push({ findingKey: key(profileIndex, profile.sheetIndex, note.code), label: 'Detected encoding', value: note.formats?.[0] ?? 'detected', demoted: false });
    if (note.code === 'leading_blank_rows_skipped') defaults.push({ findingKey: key(profileIndex, profile.sheetIndex, note.code), label: 'Skipped leading blank rows', value: String(note.count ?? 0), demoted: false });
    if (note.code === 'blank_rows') defaults.push({ findingKey: key(profileIndex, profile.sheetIndex, note.code), label: 'Ignored blank rows', value: String(note.count ?? profile.blankRowCount), demoted: false });
  }
  return defaults;
}

/**
 * Convert profiler facts into bounded questions, disclosed defaults, and notices.
 *
 * @param profiles Stored table profiles in file order.
 * @param options Optional server-configured pre-flight decision cap.
 * @returns Deterministically ordered findings capped by D06.
 * @example classifyFindings([profile]).required.length <= 3
 */
export function classifyFindings(profiles: readonly TableProfile[], options: { readonly maxDecisions?: number } = {}): { required: Finding[]; defaults: AppliedDefault[]; notices: Notice[] } {
  const required: Finding[] = [];
  const defaults = profiles.flatMap(cosmeticDefaults);
  const notices: Notice[] = [];
  profiles.forEach((profile, profileIndex) => {
    for (const note of profile.notes) {
      const finding = noteFinding(profile, profileIndex, note);
      if (finding) required.push(finding);
      if (note.code === 'row_cap_reached') notices.push({ findingKey: key(profileIndex, profile.sheetIndex, note.code), text: 'Statistics cover only the profiled portion of this table.' });
    }
    if (!profile.rowCountExact && !noteFor(profile, 'row_cap_reached')) notices.push({ findingKey: key(profileIndex, profile.sheetIndex, 'row_count_inexact'), text: 'The row count is a lower bound because profiling stopped at its limit.' });
    profile.columns.forEach((_column, columnIndex) => { const finding = mixedFinding(profile, profileIndex, columnIndex); if (finding) required.push(finding); });
  });
  const nonEmpty = profiles.filter((profile) => profile.rowCount > 0);
  if (new Set(nonEmpty.map(({ sheetIndex }) => sheetIndex)).size > 1) {
    const first = nonEmpty.find((profile) => !profile.isHidden) ?? nonEmpty[0]!;
    required.push({ findingKey: key(first.sheetIndex, 'sheet', 'multiple_sheets'), impact: 'meaning', question: 'Which worksheet should be analyzed?', rationale: 'The workbook contains more than one non-empty worksheet.', options: nonEmpty.map((profile) => option(String(profile.sheetIndex), profile.sheetName ?? `Sheet ${profile.sheetIndex + 1}`)), proposedDefault: String(first.sheetIndex), profileIndex: first.sheetIndex, columnPosition: -1 });
  }
  for (const profile of nonEmpty.filter((item) => item.isHidden)) required.push({ findingKey: key(profile.sheetIndex, 'sheet', 'hidden_sheet'), impact: 'meaning', question: `Should hidden worksheet ${profile.sheetName ?? profile.sheetIndex + 1} be included?`, rationale: 'The hidden worksheet contains data.', options: [option('include'), option('exclude')], proposedDefault: 'exclude', profileIndex: profile.sheetIndex, columnPosition: -1 });
  required.sort((a, b) => (a.impact === b.impact ? 0 : a.impact === 'data_loss' ? -1 : 1) || a.profileIndex - b.profileIndex || a.columnPosition - b.columnPosition || a.findingKey.localeCompare(b.findingKey));
  const maximum = options.maxDecisions ?? MAX_PREFLIGHT_DECISIONS;
  const kept = required.slice(0, maximum);
  defaults.push(...required.slice(maximum).map((finding) => ({ findingKey: finding.findingKey, label: finding.question, value: finding.proposedDefault, options: finding.options, demoted: true })));
  return { required: kept, defaults, notices };
}
