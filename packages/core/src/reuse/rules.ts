import type { Finding } from '../disclosure/ambiguity';
import type { TableProfile } from '../contracts/upload-api';
import { type ContractSourceInput, type RecordedRule, type TableSelector } from './input-contract';

export interface TableIndexEntry { readonly profileIndex: number; readonly inputPosition: number; readonly sheetIndex: number; readonly sheetName: string | null; readonly table: TableProfile; readonly selector: TableSelector }
export interface RuleAnswer { readonly findingKey: string | null; readonly answer: string | null; readonly proposedDefault?: string | null; readonly question: string; readonly status?: string }

/** Parse from both ends because a column name can contain a colon or be '0'.
 * @param key A classifier finding key.
 * @returns Its profile index, target, kind, and optional column or sheet index.
 * @example parseFindingKey('0:date:ambiguous_date_format')
 */
export function parseFindingKey(key: string): { profileIndex: number; target: string; kind: string; column: string | null; sheetIndex: number | null } {
  const first = key.indexOf(':');
  const last = key.lastIndexOf(':');
  if (first < 1 || last <= first) throw new Error(`Invalid finding key: ${key}`);
  const profileIndex = Number(key.slice(0, first));
  const target = key.slice(first + 1, last);
  const kind = key.slice(last + 1);
  if (!Number.isInteger(profileIndex) || profileIndex < 0 || !kind) throw new Error(`Invalid finding key: ${key}`);
  const column = kind === 'mixed_type_column' || kind === 'ambiguous_date_format' ? target : null;
  return { profileIndex, target, kind, column, sheetIndex: column === null && /^\d+$/.test(target) ? Number(target) : null };
}

/** Reproduce classifier order: selected slot order, then sheets by index.
 * @param inputs Ordered input slots and their profiled tables.
 * @returns Table entries with classifier profile indices.
 * @example buildTableIndex([{ position: 0, inputName: 'a.csv', label: 'a.csv', format: 'csv', sourceSha256: '', tables: [] }])
 */
export function buildTableIndex(inputs: readonly (ContractSourceInput & { readonly uploadId?: number })[]): TableIndexEntry[] {
  const ordered = [...inputs].sort((a, b) => a.position - b.position);
  return ordered.flatMap((input) => [...input.tables].sort((a, b) => a.sheetIndex - b.sheetIndex).map((table) => ({ inputPosition: input.position, sheetIndex: table.sheetIndex, sheetName: table.sheetName, table, selector: input.format === 'csv' ? { kind: 'only' as const } : { kind: 'sheet' as const, name: table.sheetName ?? '' } }))).map((entry, profileIndex) => ({ ...entry, profileIndex }));
}

/** Convert positional finding answers to stable file/table/column rules.
 * @param answers Answers saved on the accepted run.
 * @param findings Original classifier findings.
 * @param tableIndex Original input and table order.
 * @returns Rules anchored to file slots and table selectors.
 * @example recordRules([], [], [])
 */
export function recordRules(answers: readonly RuleAnswer[], findings: readonly Finding[], tableIndex: readonly TableIndexEntry[]): RecordedRule[] {
  const byKey = new Map(findings.map((finding) => [finding.findingKey, finding]));
  return answers.flatMap((item) => {
    if (!item.findingKey) return [];
    const parsed = parseFindingKey(item.findingKey);
    const entry = tableIndex[parsed.profileIndex];
    if (!entry || !byKey.has(item.findingKey)) return [];
    const answer = item.answer ?? item.proposedDefault;
    if (answer == null) return [];
    return [{ inputPosition: entry.inputPosition, table: entry.selector, column: parsed.column, kind: parsed.kind, answer, question: item.question }];
  });
}

function matchingEntry(rule: RecordedRule, tableIndex: readonly TableIndexEntry[]): TableIndexEntry | undefined {
  return tableIndex.find((entry) => entry.inputPosition === rule.inputPosition && (rule.table.kind === 'first' ? entry.sheetIndex === 0 : rule.table.kind === 'only' ? entry.selector.kind === 'only' : entry.sheetName === rule.table.name));
}

/** The classifier key a rule would have on this table; workbook-level findings target `sheet`, as FEAT-105 keys them. */
function ruleKey(rule: RecordedRule, entry: TableIndexEntry): string {
  const target = rule.column ?? (rule.kind === 'multiple_sheets' || rule.kind === 'hidden_sheet' ? 'sheet' : entry.sheetIndex);
  return `${entry.profileIndex}:${target}:${rule.kind}`;
}

/** Reconstruct current classifier keys for semantic rules.
 * @param rules Saved semantic rules.
 * @param newIndex Current input and table order.
 * @returns Current finding keys mapped to saved answers.
 * @example rekeyRules([], [])
 */
export function rekeyRules(rules: readonly RecordedRule[], newIndex: readonly TableIndexEntry[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rule of rules) {
    const entry = matchingEntry(rule, newIndex);
    if (entry) result[ruleKey(rule, entry)] = rule.answer;
  }
  return result;
}

/** A known day-first/month-first order, or null when the format says neither.
 * @param format Detected date format.
 * @returns True for day first, false for month first, or null.
 * @example dayFirstOf('DD/MM/YYYY')
 */
export function dayFirstOf(format: string | null): boolean | null {
  if (!format || format === 'excel-native' || /^Y/.test(format)) return null;
  if (/^D{1,2}[/.-]M{1,2}/i.test(format)) return true;
  if (/^M{1,2}[/.-]D{1,2}/i.test(format)) return false;
  return null;
}

export interface EvaluatedRules { readonly applied: RecordedRule[]; readonly notNeeded: RecordedRule[]; readonly conflicts: { rule: RecordedRule; finding: Finding | null }[]; readonly unrecorded: Finding[] }

/** Compare saved choices to current findings and unambiguous date evidence.
 * @param rules Saved choices.
 * @param newFindings Current classifier findings.
 * @param tables Current table index.
 * @returns Applied, unnecessary, conflicting, and unrecorded choices.
 * @example evaluateRules([], [], [])
 */
export function evaluateRules(rules: readonly RecordedRule[], newFindings: readonly Finding[], tables: readonly TableIndexEntry[]): EvaluatedRules {
  const keyed = rekeyRules(rules, tables);
  const byKey = new Map(newFindings.map((finding) => [finding.findingKey, finding]));
  const result: EvaluatedRules = { applied: [], notNeeded: [], conflicts: [], unrecorded: newFindings.filter((finding) => !(finding.findingKey in keyed)) };
  for (const rule of rules) {
    const entry = matchingEntry(rule, tables);
    const finding = entry ? byKey.get(ruleKey(rule, entry)) : undefined;
    const dateConflict = entry ? unambiguousDateConflict(rule, entry) : undefined;
    if (dateConflict === null) result.notNeeded.push(rule);
    else if (dateConflict) result.conflicts.push({ rule, finding: finding ?? dateConflict });
    else if (!finding) result.notNeeded.push(rule);
    else if (!finding.options.some((option) => option.value === rule.answer)) result.conflicts.push({ rule, finding });
    else result.applied.push(rule);
  }
  return result;
}

/**
 * Judge a recorded date order against a new column whose format is **unambiguous**.
 * An ambiguous column (FEAT-104's `ambiguous` flag) is left to the classifier's finding,
 * because its `detectedFormat` is only the first of two equally good readings.
 * @returns `undefined` when this rule is not a date order judged this way, `null` when the
 *   new column already agrees, or a synthetic finding asking the person to choose.
 */
function unambiguousDateConflict(rule: RecordedRule, entry: TableIndexEntry): Finding | null | undefined {
  if (rule.kind !== 'ambiguous_date_format') return undefined;
  const column = entry.table.columns.find((item) => item.name === rule.column);
  const stats = column?.stats?.kind === 'temporal' ? column.stats : null;
  const savedOrder = dayFirstOf(rule.answer);
  const order = stats && !stats.ambiguous ? dayFirstOf(stats.detectedFormat) : null;
  if (!stats || savedOrder === null || order === null) return undefined;
  if (savedOrder === order) return null;
  const options = [{ value: rule.answer, label: rule.answer }, { value: stats.detectedFormat, label: stats.detectedFormat }];
  return { findingKey: ruleKey(rule, entry), profileIndex: entry.profileIndex, columnPosition: column!.position, impact: 'meaning', question: rule.question, rationale: 'The new file has a different unambiguous date order.', options, proposedDefault: stats.detectedFormat };
}
