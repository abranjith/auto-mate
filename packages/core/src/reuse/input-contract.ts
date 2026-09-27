import { Type, type Static } from '@sinclair/typebox';
import type { DeclaredInput } from '../contracts/generation-api';
import { FileFormatSchema, InferredTypeSchema, type FileFormat, type TableProfile } from '../contracts/upload-api';
import { canonicalStringify } from '../disclosure/canonical-json';
import { ValidationError } from '../errors/index';
import { sha256Hex } from '../generation/sha256';

const Closed = { additionalProperties: false } as const;
export const TableSelectorSchema = Type.Union([
  Type.Object({ kind: Type.Literal('only') }, Closed),
  Type.Object({ kind: Type.Literal('sheet'), name: Type.String() }, Closed),
  Type.Object({ kind: Type.Literal('first'), name: Type.String() }, Closed),
]);
export type TableSelector = Static<typeof TableSelectorSchema>;
export const RecordedRuleSchema = Type.Object({ inputPosition: Type.Integer({ minimum: 0 }), table: TableSelectorSchema, column: Type.Union([Type.String(), Type.Null()]), kind: Type.String(), answer: Type.String(), question: Type.String() }, Closed);
export type RecordedRule = Static<typeof RecordedRuleSchema>;
const ContractColumnSchema = Type.Object({ name: Type.String(), position: Type.Integer({ minimum: 0 }), sourceType: InferredTypeSchema, temporalFormat: Type.Union([Type.String(), Type.Null()]), required: Type.Boolean(), declaredType: Type.Union([InferredTypeSchema, Type.Null()]) }, Closed);
export const InputContractSchema = Type.Object({
  version: Type.Literal(1),
  inputs: Type.Array(Type.Object({ position: Type.Integer({ minimum: 0 }), inputName: Type.String(), label: Type.String(), format: FileFormatSchema, sourceSha256: Type.String(), declared: Type.Boolean(), tables: Type.Array(Type.Object({ selector: TableSelectorSchema, columns: Type.Array(ContractColumnSchema) }, Closed)) }, Closed)),
  rules: Type.Array(RecordedRuleSchema),
  notes: Type.Array(Type.Object({ question: Type.String(), answer: Type.String() }, Closed)),
}, Closed);
export type InputContract = Static<typeof InputContractSchema>;

export interface ContractSourceInput { readonly position: number; readonly inputName: string; readonly label: string; readonly format: FileFormat; readonly sourceSha256: string; readonly tables: readonly TableProfile[] }
export interface ContractSource { readonly inputs: readonly ContractSourceInput[]; readonly declaredInputs: readonly DeclaredInput[]; readonly answeredFindings?: readonly RecordedRule[]; readonly notes?: readonly { readonly question: string; readonly answer: string }[] }

/** A short, human-readable table name.
 * @param selector The recorded table selector.
 * @returns A label for the selected table.
 * @example selectorLabel({ kind: 'only' })
 */
export function selectorLabel(selector: TableSelector): string {
  return selector.kind === 'only' ? 'the file' : selector.name;
}

function selectedTables(input: ContractSourceInput, declarations: readonly DeclaredInput[]): { selector: TableSelector; table: TableProfile; declaration?: DeclaredInput }[] {
  if (declarations.length === 0) return [];
  if (input.format === 'csv') return input.tables.slice(0, 1).map((table) => ({ selector: { kind: 'only' }, table, declaration: declarations[0] }));
  const named = declarations.filter((item) => item.sheet);
  if (named.length) return named.map((declaration) => {
    const table = input.tables.find((item) => item.sheetName === declaration.sheet);
    if (!table) throw new ValidationError(`Required sheet ${declaration.sheet} is absent from ${input.label}.`);
    return { selector: { kind: 'sheet', name: declaration.sheet! }, table, declaration };
  });
  const table = input.tables.find((item) => item.sheetIndex === 0);
  if (!table) throw new ValidationError(`The first sheet is absent from ${input.label}.`);
  return [{ selector: { kind: 'first', name: table.sheetName ?? '' }, table, declaration: declarations[0] }];
}

function contractTable(selected: { selector: TableSelector; table: TableProfile; declaration?: DeclaredInput }) {
  const required = selected.declaration?.requiredColumns ?? [];
  for (const entry of required) if (!selected.table.columns.some((column) => column.name === entry.name)) throw new ValidationError(`Required column ${entry.name} is absent.`);
  return { selector: selected.selector, columns: [...selected.table.columns].sort((a, b) => a.position - b.position).map((column) => {
    const declared = required.find((entry) => entry.name === column.name);
    return { name: column.name, position: column.position, sourceType: column.inferredType, temporalFormat: column.stats?.kind === 'temporal' ? column.stats.detectedFormat : null, required: !!declared, declaredType: declared?.type ?? null };
  }) };
}

/** Snapshot shape and decisions only; sample rows and value statistics never enter the contract.
 * @param source Accepted run inputs, declared reads, and answered findings.
 * @returns A versioned input contract.
 * @example buildInputContract({ inputs: [], declaredInputs: [] })
 */
export function buildInputContract(source: ContractSource): InputContract {
  return { version: 1, inputs: [...source.inputs].sort((a, b) => a.position - b.position).map((input) => {
    const declarations = source.declaredInputs.filter((item) => item.fileRole === input.inputName);
    const tables = selectedTables(input, declarations).map(contractTable).sort((a, b) => selectorLabel(a.selector).localeCompare(selectorLabel(b.selector)));
    return { position: input.position, inputName: input.inputName, label: input.label, format: input.format, sourceSha256: input.sourceSha256, declared: declarations.length > 0, tables };
  }), rules: [...(source.answeredFindings ?? [])], notes: [...(source.notes ?? [])] };
}

/** Digest every contract field with canonical key ordering.
 * @param contract The complete saved input contract.
 * @returns Its SHA-256 hex digest.
 * @example contractDigest(buildInputContract({ inputs: [], declaredInputs: [] }))
 */
export function contractDigest(contract: InputContract): string {
  return sha256Hex(canonicalStringify(contract));
}
