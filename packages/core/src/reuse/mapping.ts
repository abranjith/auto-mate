import { Type, type Static } from '@sinclair/typebox';
import { ValidationError } from '../errors/index';
import type { TableProfile } from '../contracts/upload-api';
import type { CompatibilityReport } from './compatibility';
import type { InputContract } from './input-contract';
import { MAX_MAPPING_NOTE_CHARS } from './limits';
import { parseFindingKey } from './rules';
import { REPAIR_INSTRUCTIONS_PREFACE } from './wording';

const Closed = { additionalProperties: false } as const;
export const RepairMappingSchema = Type.Object({
  columns: Type.Array(Type.Object({ inputPosition: Type.Integer({ minimum: 0 }), sheet: Type.Union([Type.String(), Type.Null()]), expected: Type.String(), use: Type.Union([Type.String(), Type.Null()]) }, Closed)),
  sheets: Type.Array(Type.Object({ inputPosition: Type.Integer({ minimum: 0 }), expected: Type.String(), use: Type.Union([Type.String(), Type.Null()]) }, Closed)),
  decisions: Type.Array(Type.Object({ findingKey: Type.String(), answer: Type.String() }, Closed)),
  note: Type.Union([Type.String({ maxLength: MAX_MAPPING_NOTE_CHARS }), Type.Null()]),
}, Closed);
export type RepairMapping = Static<typeof RepairMappingSchema>;
export interface CandidateTable { readonly inputPosition: number; readonly table: TableProfile }

function sameColumn(left: { inputPosition: number; sheet: string | null; expected: string }, right: { inputPosition: number; sheet: string | null; expected: string }): boolean {
  return left.inputPosition === right.inputPosition && left.sheet === right.sheet && left.expected === right.expected;
}

/** Require one valid choice for every blocking mapping or decision, and no unrelated choice.
 * @param mapping The person's requested repair choices.
 * @param report The compatibility findings being resolved.
 * @param candidateTables Profiled tables available as mapping targets.
 * @returns Nothing when all choices are valid; otherwise throws.
 * @example validateMapping({ columns: [], sheets: [], decisions: [], note: null }, report, [])
 */
export function validateMapping(mapping: RepairMapping, report: CompatibilityReport, candidateTables: readonly CandidateTable[]): void {
  if (mapping.note && mapping.note.length > MAX_MAPPING_NOTE_CHARS) throw new ValidationError('The repair note is too long.');
  const columns = report.findings.filter((item) => item.code === 'column_missing');
  const sheets = report.findings.filter((item) => item.code === 'sheet_missing');
  const decisions = report.findings.filter((item) => item.code === 'decision_unrecorded' || item.code === 'rule_conflict');
  if (mapping.columns.length !== columns.length || mapping.sheets.length !== sheets.length || mapping.decisions.length !== decisions.length) throw new ValidationError('Choose one mapping or answer for every missing item.');
  if (new Set(mapping.columns.map((item) => `${item.inputPosition}:${item.sheet ?? ''}:${item.expected}`)).size !== mapping.columns.length || new Set(mapping.sheets.map((item) => `${item.inputPosition}:${item.expected}`)).size !== mapping.sheets.length || new Set(mapping.decisions.map((item) => item.findingKey)).size !== mapping.decisions.length) throw new ValidationError('Choose each mapping or answer only once.');
  for (const entry of mapping.columns) {
    if (!columns.some((item) => sameColumn(entry, { inputPosition: item.inputPosition, sheet: item.sheet, expected: item.column ?? '' }))) throw new ValidationError(`Column ${entry.expected} was not requested by the report.`);
    if (entry.use !== null && !candidateTables.some(({ inputPosition, table }) => inputPosition === entry.inputPosition && table.sheetName === entry.sheet && table.columns.some((column) => column.name === entry.use))) throw new ValidationError(`Column ${entry.use} is not in the new file.`);
  }
  for (const entry of mapping.sheets) {
    if (!sheets.some((item) => item.inputPosition === entry.inputPosition && item.sheet === entry.expected)) throw new ValidationError(`Worksheet ${entry.expected} was not requested by the report.`);
    if (entry.use !== null && !candidateTables.some(({ inputPosition, table }) => inputPosition === entry.inputPosition && table.sheetName === entry.use)) throw new ValidationError(`Worksheet ${entry.use} is not in the new file.`);
  }
  for (const entry of mapping.decisions) {
    const issue = decisions.find((item) => (item.finding as { findingKey?: string } | undefined)?.findingKey === entry.findingKey);
    if (!issue) throw new ValidationError(`Decision ${entry.findingKey} was not requested by the report.`);
    const options = (issue.finding as { options?: readonly { value: string }[] } | undefined)?.options ?? [];
    if (!options.some((option) => option.value === entry.answer)) throw new ValidationError(`Decision ${entry.findingKey} has an invalid answer.`);
  }
}

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth'] as const;
function fileLabel(position: number): string { return `${ORDINALS[position] ?? `${position + 1}th`} file`; }

/** What a FEAT-105 decision is about, in plain words; unknown kinds fall back to a neutral phrase. */
const DECISION_SUBJECTS: Readonly<Record<string, string>> = {
  ambiguous_date_format: 'how its dates are read',
  mixed_type_column: 'values that do not match its type',
  no_header_detected: 'whether row 1 holds headings',
  ragged_rows: 'rows with a different number of fields',
  merged_cells: 'merged cells',
  multiple_sheets: 'which worksheet to use',
  hidden_sheet: 'the hidden worksheet',
};

/** One decision as a sentence naming the column (the person's own heading) but never a key or filename. */
function decisionSentence(findingKey: string, answer: string): string {
  let parsed: ReturnType<typeof parseFindingKey> | null;
  try { parsed = parseFindingKey(findingKey); } catch { parsed = null; }
  const subject = (parsed && DECISION_SUBJECTS[parsed.kind]) ?? 'a choice about the file';
  return parsed?.column ? `For the column “${parsed.column}” (${subject}), use “${answer}”.` : `For ${subject}, use “${answer}”.`;
}

/** Fixed sentences shown verbatim before they enter the repair prompt.
 * @param mapping The reviewed mapping and freeform note.
 * @param _contract The saved input contract, reserved for future wording.
 * @returns The exact repair instructions sent to the AI.
 * @example renderMappingInstructions({ columns: [], sheets: [], decisions: [], note: 'Use totals.' }, contract)
 */
export function renderMappingInstructions(mapping: RepairMapping, _contract: InputContract): string {
  const lines = [REPAIR_INSTRUCTIONS_PREFACE];
  for (const item of mapping.columns) lines.push(item.use === null ? `In the ${fileLabel(item.inputPosition)}, the column “${item.expected}” no longer exists; do the task without it.` : `In the ${fileLabel(item.inputPosition)}, use the column “${item.use}” wherever the saved task used “${item.expected}”.`);
  for (const item of mapping.sheets) lines.push(item.use === null ? `In the ${fileLabel(item.inputPosition)}, the sheet “${item.expected}” no longer exists; do the task without it.` : `In the ${fileLabel(item.inputPosition)}, the sheet “${item.use}” is the one the saved task called “${item.expected}”.`);
  for (const item of mapping.decisions) lines.push(decisionSentence(item.findingKey, item.answer));
  if (mapping.note) lines.push(mapping.note);
  return lines.join('\n');
}
