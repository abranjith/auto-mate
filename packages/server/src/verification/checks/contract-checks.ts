// ---------------------------------------------------------------------------
// Contract checks (FEAT-107 TASK-007): the ones only the application can make,
// because only it holds both the agent's declarations and the person's file
// profile. They read DECLARATIONS and PROFILES — column names and types —
// never an upload's bytes, and no finding ever carries a cell value.
//
//   contract_entrypoint — the entrypoint is one of the version's script files.
//   contract_outputs    — the declared outputs are well-formed and unambiguous.
//   contract_inputs     — every column the script needs exists in the file.
//                         A missing column BLOCKS (the script certainly fails);
//                         a type mismatch is ADVISORY (it usually still works).
// ---------------------------------------------------------------------------

import { ARTIFACT_TYPES, isPlainFilename, type CodeFileRole, type DeclaredInput, type InferredType, type TableProfile } from '@automate/core';
import type { CodeVersionWithFiles } from '../../db/repositories/code-version-repository';
import { plural, resolveFinding, type CheckOutcome, type RawFinding } from './check-result';

/** One attached upload as the input check sees it: the stored name the script reads, and its profiled tables. */
export interface ProfiledInput {
  readonly storedFilename: string;
  readonly tables: readonly Pick<TableProfile, 'sheetName' | 'columns'>[];
}

const high = (ruleCode: string, filePath: string | null, message: string): RawFinding => ({ ruleCode, severity: 'high', confidence: null, filePath, line: null, column: null, message });
const low = (ruleCode: string, message: string): RawFinding => ({ ruleCode, severity: 'low', confidence: null, filePath: null, line: null, column: null, message });
const echo = (text: string) => { const printable = [...text].filter((char) => char.charCodeAt(0) >= 0x20).join(''); return printable.length > 64 ? `${printable.slice(0, 63)}…` : printable; };

function outcomeOf(checkKey: 'contract_entrypoint' | 'contract_outputs' | 'contract_inputs', raw: readonly RawFinding[], passed: string, started: number, detail?: unknown): CheckOutcome {
  const findings = raw.map((item) => resolveFinding(checkKey, item));
  const blocking = findings.filter(({ isBlocking }) => isBlocking).length;
  const advisory = findings.length - blocking;
  const noun = { contract_entrypoint: 'entry point problem', contract_outputs: 'output declaration problem', contract_inputs: 'missing input column' }[checkKey];
  const summary = blocking > 0 ? `${plural(blocking, noun)}${advisory ? ` and ${plural(advisory, 'advisory finding')}` : ''}` : advisory > 0 ? `${passed}; ${plural(advisory, 'type difference')} to review` : passed;
  return { status: blocking > 0 ? 'failed' : 'passed', findings, summary, durationMs: Math.round(performance.now() - started), ...(detail === undefined ? {} : { detail }) };
}

/** The entrypoint must be one of the version's `script` files — not a test, not a missing file. */
export function checkEntrypoint(version: CodeVersionWithFiles): CheckOutcome {
  const started = performance.now();
  const file = version.files.find(({ path }) => path === version.entrypoint);
  const raw: RawFinding[] = [];
  if (!file) raw.push(high('entrypoint_missing', null, `The script says it starts from \`${echo(version.entrypoint)}\`, but no such file was written.`));
  else if ((file.role as CodeFileRole) !== 'script') raw.push(high('entrypoint_not_script', file.path, `The script says it starts from \`${echo(version.entrypoint)}\`, which is a ${file.role} file, not a script.`));
  return outcomeOf('contract_entrypoint', raw, `Starts from ${echo(version.entrypoint)}`, started);
}

function parseJsonArray(text: string | null): unknown[] | null {
  if (text === null) return null;
  try { const value: unknown = JSON.parse(text); return Array.isArray(value) ? value : null; } catch { return null; }
}

/** One declared output's problems: a plain relative filename, a known type, and no duplicate. */
function outputProblems(entry: unknown, index: number, seen: Set<string>): RawFinding[] {
  const item = (entry && typeof entry === 'object' ? entry : {}) as { filename?: unknown; type?: unknown };
  const name = typeof item.filename === 'string' ? item.filename : '';
  const label = name ? `\`${echo(name)}\`` : `output ${index + 1}`;
  const found: RawFinding[] = [];
  if (!isPlainFilename(name)) found.push(high('invalid_output_name', null, `${label} is not a plain file name; outputs must be written directly into the output folder.`));
  if (typeof item.type !== 'string' || !(ARTIFACT_TYPES as readonly string[]).includes(item.type)) found.push(high('invalid_output_type', null, `${label} has a type this app cannot show (${echo(String(item.type ?? 'none'))}); use one of ${ARTIFACT_TYPES.join(', ')}.`));
  if (name && seen.has(name)) found.push(high('duplicate_output', null, `${label} is declared more than once.`));
  if (name) seen.add(name);
  return found;
}

/** Declared outputs must parse, be non-empty, and name distinct plain files of known types. */
export function checkOutputs(version: CodeVersionWithFiles): CheckOutcome {
  const started = performance.now();
  const entries = parseJsonArray(version.declaredOutputs);
  if (!entries) return outcomeOf('contract_outputs', [high('outputs_unreadable', null, 'The script did not declare its outputs in a form this app can read.')], '', started);
  if (entries.length === 0) return outcomeOf('contract_outputs', [high('outputs_empty', null, 'The script does not say it produces anything.')], '', started);
  const seen = new Set<string>();
  const raw = entries.flatMap((entry, index) => outputProblems(entry, index, seen));
  return outcomeOf('contract_outputs', raw, `Declares ${plural(entries.length, 'output')}`, started, { declared: entries.length });
}

/** Whether a column profiled as `actual` satisfies a script that declared `declared`. */
function compatible(declared: InferredType, actual: InferredType): boolean {
  if (declared === actual || declared === 'string') return true;
  return (declared === 'decimal' && actual === 'integer') || (declared === 'datetime' && actual === 'date');
}

/** One declared input compared with its file's profile. Names the column and the file; never a value. */
function inputProblems(input: DeclaredInput, uploads: readonly ProfiledInput[]): RawFinding[] {
  const upload = uploads.find(({ storedFilename }) => storedFilename === input.fileRole);
  const file = `\`${echo(input.fileRole)}\``;
  if (!upload) return [high('missing_input', null, `The script reads ${file}, but no attached file has that name.`)];
  const table = input.sheet === undefined ? upload.tables[0] : upload.tables.find(({ sheetName }) => sheetName === input.sheet);
  if (!table) return [high('missing_input', null, `The script reads sheet "${echo(input.sheet ?? '')}" of ${file}, but that sheet was not found.`)];
  return input.requiredColumns.flatMap((column): RawFinding[] => {
    const actual = table.columns.find(({ name }) => name === column.name);
    if (!actual) return [high('missing_column', null, `The script needs a column named "${echo(column.name)}" in ${file}, but the file has no such column.`)];
    return compatible(column.type, actual.inferredType) ? [] : [low('type_mismatch', `The script treats "${echo(column.name)}" in ${file} as ${column.type}, but it looks like ${actual.inferredType} in the file.`)];
  });
}

/**
 * Every column the script declares it needs must exist in the person's file.
 * @param uploads The execution's attached uploads with their stored profiles; empty skips the check.
 */
export function checkInputs(version: CodeVersionWithFiles, uploads: readonly ProfiledInput[]): CheckOutcome {
  const started = performance.now();
  if (uploads.length === 0) return { status: 'skipped', findings: [], summary: 'No input files to compare against', durationMs: 0 };
  const declared = parseJsonArray(version.declaredInputs) as DeclaredInput[] | null;
  if (!declared) return outcomeOf('contract_inputs', [high('missing_input', null, 'The script did not declare which inputs it reads in a form this app can read.')], '', started);
  const raw = declared.flatMap((input) => inputProblems(input, uploads));
  const columns = declared.reduce((sum, input) => sum + input.requiredColumns.length, 0);
  return outcomeOf('contract_inputs', raw, `All ${plural(columns, 'required column')} found`, started, { inputs: declared.length, columns });
}
