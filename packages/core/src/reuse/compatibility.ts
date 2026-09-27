import { Type, type Static } from '@sinclair/typebox';
import type { FileFormat, TableProfile } from '../contracts/upload-api';
import type { Finding } from '../disclosure/ambiguity';
import { canonicalStringify } from '../disclosure/canonical-json';
import { sha256Hex } from '../generation/sha256';
import { describeRuntimeChange, type RuntimeDetail } from '../verification/runtime-fingerprint';
import { AsOfSchema, type AsOf } from './as-of';
import { contractDigest, type InputContract, type TableSelector } from './input-contract';
import { compareColumnType } from './type-compatibility';
import { evaluateRules, type TableIndexEntry } from './rules';

export const COMPATIBILITY_FINDING_CODES = [
  'input_count_mismatch', 'file_not_analyzed', 'format_mismatch', 'sheet_missing', 'column_missing', 'type_incompatible', 'rule_conflict', 'decision_unrecorded',
  'type_changed', 'column_empty', 'no_data_rows', 'first_sheet_renamed', 'undeclared_input', 'runtime_changed', 'runtime_unknown', 'wall_clock_with_chosen_date',
  'rule_applied', 'rule_not_needed', 'extra_columns', 'optional_column_missing', 'reads_wall_clock',
] as const;
export type CompatibilityFindingCode = (typeof COMPATIBILITY_FINDING_CODES)[number];
const Closed = { additionalProperties: false } as const;
export const CompatibilityFindingSchema = Type.Object({ code: Type.Union(COMPATIBILITY_FINDING_CODES.map((code) => Type.Literal(code))), severity: Type.Union([Type.Literal('blocking'), Type.Literal('advisory'), Type.Literal('info')]), inputPosition: Type.Integer(), sheet: Type.Union([Type.String(), Type.Null()]), column: Type.Union([Type.String(), Type.Null()]), expected: Type.Union([Type.String(), Type.Null()]), found: Type.Union([Type.String(), Type.Null()]), suggestion: Type.Union([Type.String(), Type.Null()]), finding: Type.Optional(Type.Unknown()) }, Closed);
export type CompatibilityFinding = Static<typeof CompatibilityFindingSchema>;
export const CompatibilityReportSchema = Type.Object({ version: Type.Literal(1), templateId: Type.Integer(), revisionNumber: Type.Integer(), contractDigest: Type.String(), status: Type.Union([Type.Literal('compatible'), Type.Literal('compatible_with_warnings'), Type.Literal('incompatible')]), inputs: Type.Array(Type.Object({ position: Type.Integer(), uploadId: Type.Integer(), label: Type.String(), format: Type.String() }, Closed)), findings: Type.Array(CompatibilityFindingSchema), rules: Type.Object({ applied: Type.Integer(), notNeeded: Type.Integer(), conflicts: Type.Integer(), unrecorded: Type.Integer() }, Closed), runtime: Type.Object({ revision: Type.String(), current: Type.Union([Type.String(), Type.Null()]), changes: Type.Array(Type.String()) }, Closed), asOf: AsOfSchema }, Closed);
export type CompatibilityReport = Static<typeof CompatibilityReportSchema>;
export interface CandidateInput { readonly position: number; readonly uploadId: number; readonly label: string; readonly format: FileFormat; readonly tables: readonly TableProfile[]; readonly profiled?: boolean }
export interface CompatibilityCandidate { readonly inputs: readonly CandidateInput[]; readonly findings: readonly Finding[]; readonly tableIndex: readonly TableIndexEntry[] }
export interface CompatibilityContext { readonly templateId: number; readonly revisionNumber: number; readonly revisionRuntime: { readonly fingerprint: string; readonly detail: RuntimeDetail }; readonly currentRuntime: { readonly fingerprint: string; readonly detail: RuntimeDetail } | null; readonly readsWallClock: boolean; readonly asOf: AsOf }

type Push = (code: CompatibilityFindingCode, severity: CompatibilityFinding['severity'], position: number, sheet?: string | null, column?: string | null, expected?: string | null, found?: string | null, suggestion?: string | null, finding?: Finding) => void;
function pickTable(selector: TableSelector, tables: readonly TableProfile[]): TableProfile | undefined {
  return selector.kind === 'only' || selector.kind === 'first' ? tables.find((table) => table.sheetIndex === 0) : tables.find((table) => table.sheetName === selector.name);
}

function compareColumns(expected: InputContract['inputs'][number]['tables'][number], table: TableProfile, position: number, push: Push): void {
  const actual = new Map(table.columns.map((column) => [column.name, column]));
  for (const column of expected.columns) {
    const found = actual.get(column.name);
    if (!found) {
      const suggestion = table.columns.find((item) => item.name.trim().toLocaleLowerCase() === column.name.trim().toLocaleLowerCase())?.name ?? null;
      push(column.required ? 'column_missing' : 'optional_column_missing', column.required ? 'blocking' : 'info', position, table.sheetName, column.name, column.declaredType ?? column.sourceType, null, suggestion);
      continue;
    }
    if (found.inferredType === 'empty') push('column_empty', 'advisory', position, table.sheetName, column.name);
    else {
      const match = compareColumnType(column.declaredType ?? column.sourceType, found.inferredType);
      if (match !== 'same') push(match === 'blocking' ? 'type_incompatible' : 'type_changed', match, position, table.sheetName, column.name, column.declaredType ?? column.sourceType, found.inferredType);
    }
  }
  const extras = table.columns.filter((column) => !expected.columns.some((item) => item.name === column.name));
  if (extras.length) push('extra_columns', 'info', position, table.sheetName, null, null, String(extras.length));
  if (table.rowCount === 0) push('no_data_rows', 'advisory', position, table.sheetName);
}

function compareInput(expected: InputContract['inputs'][number], candidate: CandidateInput | undefined, push: Push): void {
  if (!candidate) return;
  if (candidate.profiled === false) { push('file_not_analyzed', 'blocking', expected.position); return; }
  if (candidate.format !== expected.format) { push('format_mismatch', 'blocking', expected.position, null, null, expected.format, candidate.format); return; }
  if (!expected.declared) { push('undeclared_input', 'advisory', expected.position); return; }
  for (const expectedTable of expected.tables) {
    const table = pickTable(expectedTable.selector, candidate.tables);
    if (!table) { push('sheet_missing', 'blocking', expected.position, expectedTable.selector.kind === 'sheet' ? expectedTable.selector.name : null); continue; }
    if (expectedTable.selector.kind === 'first' && expectedTable.selector.name !== table.sheetName) push('first_sheet_renamed', 'advisory', expected.position, table.sheetName, null, expectedTable.selector.name, table.sheetName);
    compareColumns(expectedTable, table, expected.position, push);
  }
}

/** Pure shape and decision check. It never opens a file or contacts a provider.
 * @param contract The accepted revision's input contract.
 * @param candidate Profiled input shapes and current findings.
 * @param context Revision runtime and the requested as-of value.
 * @returns A deterministic compatibility report.
 * @example checkCompatibility(contract, candidate, context)
 */
export function checkCompatibility(contract: InputContract, candidate: CompatibilityCandidate, context: CompatibilityContext): CompatibilityReport {
  const findings: CompatibilityFinding[] = [];
  const push: Push = (code, severity, inputPosition, sheet = null, column = null, expected = null, found = null, suggestion = null, finding) => findings.push({ code, severity, inputPosition, sheet, column, expected, found, suggestion, ...(finding ? { finding } : {}) });
  if (contract.inputs.length !== candidate.inputs.length) push('input_count_mismatch', 'blocking', -1, null, null, String(contract.inputs.length), String(candidate.inputs.length));
  for (const input of contract.inputs) compareInput(input, candidate.inputs.find((item) => item.position === input.position), push);
  const rules = evaluateRules(contract.rules, candidate.findings, candidate.tableIndex);
  for (const rule of rules.applied) push('rule_applied', 'info', rule.inputPosition, null, rule.column);
  for (const rule of rules.notNeeded) push('rule_not_needed', 'info', rule.inputPosition, null, rule.column);
  for (const conflict of rules.conflicts) push('rule_conflict', 'blocking', conflict.rule.inputPosition, null, conflict.rule.column, conflict.rule.answer, null, null, conflict.finding ?? undefined);
  for (const finding of rules.unrecorded) push('decision_unrecorded', 'blocking', candidate.tableIndex[finding.profileIndex]?.inputPosition ?? -1, null, null, null, null, null, finding);
  const changes = context.currentRuntime ? describeRuntimeChange(context.revisionRuntime.detail, context.currentRuntime.detail) : [];
  if (!context.currentRuntime) push('runtime_unknown', 'advisory', -1);
  else if (context.currentRuntime.fingerprint !== context.revisionRuntime.fingerprint) push('runtime_changed', 'advisory', -1, null, null, null, changes.join('; '));
  if (context.readsWallClock) push('reads_wall_clock', 'info', -1);
  if (context.readsWallClock && context.asOf.source === 'chosen') push('wall_clock_with_chosen_date', 'advisory', -1);
  findings.sort((a, b) => a.inputPosition - b.inputPosition || (a.sheet ?? '').localeCompare(b.sheet ?? '') || (a.column ?? '').localeCompare(b.column ?? '') || a.code.localeCompare(b.code));
  const status = findings.some((item) => item.severity === 'blocking') ? 'incompatible' : findings.some((item) => item.severity === 'advisory') ? 'compatible_with_warnings' : 'compatible';
  return { version: 1, templateId: context.templateId, revisionNumber: context.revisionNumber, contractDigest: contractDigest(contract), status, inputs: candidate.inputs.map(({ position, uploadId, label, format }) => ({ position, uploadId, label, format })), findings, rules: { applied: rules.applied.length, notNeeded: rules.notNeeded.length, conflicts: rules.conflicts.length, unrecorded: rules.unrecorded.length }, runtime: { revision: context.revisionRuntime.fingerprint, current: context.currentRuntime?.fingerprint ?? null, changes }, asOf: context.asOf };
}

/** Bind the displayed compatibility decision to a specific revision, runtime, and as-of.
 * @param report The complete compatibility report shown to the person.
 * @returns Its SHA-256 hex digest.
 * @example compatibilityDigest(report)
 */
export function compatibilityDigest(report: CompatibilityReport): string {
  return sha256Hex(canonicalStringify(report));
}
