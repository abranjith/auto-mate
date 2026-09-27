import { describe, expect, it } from 'vitest';
import type { ColumnProfile, TableProfile } from '../../contracts/upload-api';
import { table, column } from '../ingestion/profile-fixtures';
import { classifyFindings } from '../../disclosure/ambiguity';
import { resolveAsOf } from '../../reuse/as-of';
import { buildInputContract, contractDigest, type InputContract } from '../../reuse/input-contract';
import { buildTableIndex, evaluateRules, recordRules, rekeyRules, type RuleAnswer } from '../../reuse/rules';
import { COMPATIBILITY_FINDING_CODES, checkCompatibility, compatibilityDigest, type CompatibilityFinding, type CompatibilityReport } from '../../reuse/compatibility';
import { renderMappingInstructions, validateMapping, type RepairMapping } from '../../reuse/mapping';
import { REPAIR_INSTRUCTIONS_PREFACE, describeAsOf, describeColumnType, describeCompatibilityFinding, formatCalendarDate } from '../../reuse/wording';
import { isSavedCodeRun, REUSE_KINDS } from '../../reuse/reuse-kind';
import { findWallClockReads } from '../../reuse/wall-clock-scan';
import { TRANSITIONS } from '../../conversation/execution-state';
import { AS_OF_RULE, RERUNNABLE_TESTS_RULE, renderCodeContract } from '../../generation/code-contract';
import { describeTrigger } from '../../history/run-wording';

const SHA = 'a'.repeat(64);
const col = (name: string, position: number, inferredType: ColumnProfile['inferredType'] = 'integer', extra: Partial<ColumnProfile> = {}) => column({ name, position, inferredType, ...extra });
const temporal = (name: string, position: number, detectedFormat: string, ambiguous = false) => col(name, position, 'date', { stats: { kind: 'temporal', min: '2026-01-01', max: '2026-01-31', detectedFormat, ambiguous, alternateFormat: ambiguous ? 'MM/DD/YYYY' : null } });
const csvTable = (columns: ColumnProfile[], overrides: Partial<TableProfile> = {}) => table({ columns, columnCount: columns.length, ...overrides });
const sheet = (sheetName: string, sheetIndex: number, columns: ColumnProfile[], overrides: Partial<TableProfile> = {}) => table({ sheetName, sheetIndex, columns, columnCount: columns.length, delimiter: null, dialect: null, ...overrides });
const BASE = [col('region', 0, 'string'), col('amount', 1, 'integer'), col('when', 2, 'date')];

function contractFor(tables: TableProfile[], format: 'csv' | 'xlsx' = 'csv', declared: { sheet?: string; requiredColumns: { name: string; type: ColumnProfile['inferredType'] }[] }[] = [{ requiredColumns: [{ name: 'region', type: 'string' }, { name: 'amount', type: 'integer' }, { name: 'when', type: 'date' }] }]): InputContract {
  return buildInputContract({ inputs: [{ position: 0, inputName: '12-sales.csv', label: 'sales.csv', format, sourceSha256: SHA, tables }], declaredInputs: declared.map((item) => ({ fileRole: '12-sales.csv', ...item })) });
}
function context(overrides: Partial<Parameters<typeof checkCompatibility>[2]> = {}): Parameters<typeof checkCompatibility>[2] {
  const runtime = { fingerprint: SHA, detail: { pythonVersion: '3.14.6', uvVersion: '0.9', platform: 'linux', arch: 'x64', packages: [{ name: 'pandas', version: '3.0.6' }] } };
  return { templateId: 1, revisionNumber: 1, revisionRuntime: runtime, currentRuntime: runtime, readsWallClock: false, asOf: resolveAsOf({ nowMs: Date.UTC(2026, 8, 26, 12), timeZone: 'UTC' }), ...overrides };
}
function check(contract: InputContract, inputs: { tables: TableProfile[]; format?: 'csv' | 'xlsx' }[], ctx = context()): CompatibilityReport {
  const candidates = inputs.map((input, position) => ({ position, uploadId: 30 + position, label: `new-${position}.csv`, format: input.format ?? 'csv', tables: input.tables }));
  const index = buildTableIndex(candidates.map((input) => ({ ...input, inputName: `n${input.position}`, sourceSha256: SHA })));
  return checkCompatibility(contract, { inputs: candidates, findings: classifyFindings(index.map((entry) => entry.table)).required, tableIndex: index }, ctx);
}
const codes = (report: CompatibilityReport) => report.findings.map(({ code, severity }) => `${code}:${severity}`);

describe('checkCompatibility: the scenario corpus', () => {
  const contract = contractFor([csvTable(BASE)]);
  const cases: [string, TableProfile[], CompatibilityReport['status'], string[]][] = [
    ['an identical file', [csvTable(BASE)], 'compatible', []],
    ['reordered columns', [csvTable([BASE[2]!, BASE[0]!, BASE[1]!].map((item, position) => ({ ...item, position })))], 'compatible', []],
    ['extra columns', [csvTable([...BASE, col('note', 3, 'string')])], 'compatible', ['extra_columns:info']],
    ['Amount renamed to amount', [csvTable([BASE[0]!, col('Amount', 1), BASE[2]!])], 'incompatible', ['extra_columns:info', 'column_missing:blocking']],
    ['Amount renamed to Total', [csvTable([BASE[0]!, col('Total', 1), BASE[2]!])], 'incompatible', ['extra_columns:info', 'column_missing:blocking']],
    ['integer to decimal', [csvTable([BASE[0]!, col('amount', 1, 'decimal'), BASE[2]!])], 'compatible_with_warnings', ['type_changed:advisory']],
    ['decimal to string', [csvTable([BASE[0]!, col('amount', 1, 'string'), BASE[2]!])], 'incompatible', ['type_incompatible:blocking']],
    ['date to string', [csvTable([BASE[0]!, BASE[1]!, col('when', 2, 'string')])], 'incompatible', ['type_incompatible:blocking']],
    ['an empty required column', [csvTable([BASE[0]!, col('amount', 1, 'empty'), BASE[2]!])], 'compatible_with_warnings', ['column_empty:advisory']],
    ['zero rows', [csvTable(BASE, { rowCount: 0 })], 'compatible_with_warnings', ['no_data_rows:advisory']],
  ];
  it.each(cases)('%s', (_name, tables, status, expected) => {
    const report = check(contract, [{ tables }]);
    expect(report.status).toBe(status);
    expect(codes(report)).toEqual(expected);
  });

  it('suggests a case-folded match and nothing for a real rename', () => {
    expect(check(contract, [{ tables: [csvTable([BASE[0]!, col(' Amount ', 1), BASE[2]!])] }]).findings.find((item) => item.code === 'column_missing')!.suggestion).toBe(' Amount ');
    expect(check(contractFor([csvTable([BASE[0]!, col('amount', 1), BASE[2]!])]), [{ tables: [csvTable([BASE[0]!, col('Total', 1), BASE[2]!])] }]).findings.find((item) => item.code === 'column_missing')!.suggestion).toBeNull();
  });

  it('reports an optional column as information only', () => {
    const optional = contractFor([csvTable([...BASE, col('note', 3, 'string')])]);
    expect(codes(check(optional, [{ tables: [csvTable(BASE)] }]))).toEqual(['optional_column_missing:info']);
  });

  it('blocks a CSV in a workbook slot, a missing declared sheet, and the wrong number of files', () => {
    const workbook = contractFor([sheet('Sep', 0, BASE), sheet('Notes', 1, [col('text', 0, 'string')])], 'xlsx', [{ sheet: 'Sep', requiredColumns: [{ name: 'amount', type: 'integer' }] }]);
    expect(codes(check(workbook, [{ tables: [csvTable(BASE)] }]))).toEqual(['format_mismatch:blocking']);
    expect(codes(check(workbook, [{ tables: [sheet('Oct', 0, BASE), sheet('Notes', 1, [col('text', 0, 'string')])], format: 'xlsx' }]))).toContain('sheet_missing:blocking');
    expect(codes(check(contract, [{ tables: [csvTable(BASE)] }, { tables: [csvTable(BASE)] }]))).toContain('input_count_mismatch:blocking');
  });

  it('warns about a renamed first sheet when the code named none', () => {
    const first = contractFor([sheet('Sep', 0, BASE)], 'xlsx', [{ requiredColumns: [{ name: 'amount', type: 'integer' }] }]);
    const report = check(first, [{ tables: [sheet('Oct', 0, BASE)], format: 'xlsx' }]);
    expect(report.status).toBe('compatible_with_warnings');
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'first_sheet_renamed', expected: 'Sep', found: 'Oct' }));
  });

  it('blocks both slots when two files are swapped', () => {
    const two = buildInputContract({ inputs: [{ position: 0, inputName: 'a.csv', label: 'a', format: 'csv', sourceSha256: SHA, tables: [csvTable(BASE)] }, { position: 1, inputName: 'b.csv', label: 'b', format: 'csv', sourceSha256: SHA, tables: [csvTable([col('code', 0, 'string'), col('rate', 1, 'decimal')])] }], declaredInputs: [{ fileRole: 'a.csv', requiredColumns: [{ name: 'amount', type: 'integer' }] }, { fileRole: 'b.csv', requiredColumns: [{ name: 'rate', type: 'decimal' }] }] });
    const report = check(two, [{ tables: [csvTable([col('code', 0, 'string'), col('rate', 1, 'decimal')])] }, { tables: [csvTable(BASE)] }]);
    expect(report.findings.filter((item) => item.severity === 'blocking').map((item) => item.inputPosition)).toEqual([0, 1]);
  });

  it('names a changed or unknown runtime and a clock read against a chosen date', () => {
    const changed = { fingerprint: 'b'.repeat(64), detail: { ...context().revisionRuntime.detail, packages: [{ name: 'pandas', version: '3.1.0' }] } };
    const report = check(contract, [{ tables: [csvTable(BASE)] }], context({ currentRuntime: changed }));
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'runtime_changed', severity: 'advisory', found: expect.stringContaining('pandas') }));
    expect(report.runtime.changes.length).toBeGreaterThan(0);
    expect(codes(check(contract, [{ tables: [csvTable(BASE)] }], context({ currentRuntime: null })))).toEqual(['runtime_unknown:advisory']);
    const chosen = context({ readsWallClock: true, asOf: resolveAsOf({ nowMs: Date.UTC(2026, 8, 26), timeZone: 'UTC', chosenDate: '2026-08-31' }) });
    expect(codes(check(contract, [{ tables: [csvTable(BASE)] }], chosen)).sort()).toEqual(['reads_wall_clock:info', 'wall_clock_with_chosen_date:advisory']);
  });

  it('digests the whole report: stable across calls, changed by the as-of, the runtime, and the revision', () => {
    const tables = [{ tables: [csvTable(BASE)] }];
    const base = compatibilityDigest(check(contract, tables));
    expect(compatibilityDigest(check(contract, tables))).toBe(base);
    expect(compatibilityDigest(check(contract, tables, context({ asOf: resolveAsOf({ nowMs: Date.UTC(2026, 8, 27, 12), timeZone: 'UTC' }) })))).not.toBe(base);
    expect(compatibilityDigest(check(contract, tables, context({ currentRuntime: null })))).not.toBe(base);
    expect(compatibilityDigest(check(contract, tables, context({ revisionNumber: 2 })))).not.toBe(base);
  });

  it('never carries a cell value', () => {
    const sensitive = csvTable(BASE.map((item) => ({ ...item, topValues: [{ value: 'TOP_SENTINEL', count: 3 }] })), { sampleRows: [['CELL_SENTINEL', '1', '2026-01-01']] });
    const report = check(contractFor([sensitive]), [{ tables: [sensitive] }]);
    expect(JSON.stringify(report)).not.toMatch(/TOP_SENTINEL|CELL_SENTINEL/);
    expect(JSON.stringify(contractFor([sensitive]))).not.toMatch(/TOP_SENTINEL|CELL_SENTINEL/);
  });
});

describe('input contract digest', () => {
  it('changes when any single field changes and ignores key order', () => {
    const contract = contractFor([csvTable(BASE)]);
    const digest = contractDigest(contract);
    const reverseKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(reverseKeys) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)])) : value;
    const reordered = reverseKeys(contract) as InputContract;
    expect(Object.keys(reordered)).toEqual([...Object.keys(contract)].reverse());
    expect(contractDigest(reordered)).toBe(digest);
    const mutations: ((value: InputContract) => void)[] = [
      (value) => { value.inputs[0]!.label = 'other.csv'; },
      (value) => { value.inputs[0]!.inputName = '13-sales.csv'; },
      (value) => { value.inputs[0]!.sourceSha256 = 'b'.repeat(64); },
      (value) => { value.inputs[0]!.tables[0]!.columns[0]!.required = false; },
      (value) => { value.inputs[0]!.tables[0]!.columns[1]!.sourceType = 'decimal'; },
      (value) => { value.rules.push({ inputPosition: 0, table: { kind: 'only' }, column: 'when', kind: 'ambiguous_date_format', answer: 'DD/MM/YYYY', question: 'Q' }); },
      (value) => { value.notes.push({ question: 'Q', answer: 'A' }); },
    ];
    for (const mutate of mutations) { const copy = structuredClone(contract); mutate(copy); expect(contractDigest(copy)).not.toBe(digest); }
  });

  it('marks an input the agent never declared, and a workbook with no declared sheet as first', () => {
    expect(buildInputContract({ inputs: [{ position: 0, inputName: 'x.csv', label: 'x', format: 'csv', sourceSha256: SHA, tables: [csvTable(BASE)] }], declaredInputs: [] }).inputs[0]).toMatchObject({ declared: false, tables: [] });
    expect(contractFor([sheet('Sep', 0, BASE), sheet('Other', 1, BASE)], 'xlsx', [{ requiredColumns: [] }]).inputs[0]!.tables.map((item) => item.selector)).toEqual([{ kind: 'first', name: 'Sep' }]);
  });
});

describe('recorded rules against a new file', () => {
  const dates = (format: string, ambiguous: boolean) => csvTable([BASE[0]!, BASE[1]!, temporal('when', 2, format, ambiguous)], { notes: ambiguous ? [{ code: 'ambiguous_date_format', column: 'when', formats: [format, format === 'DD/MM/YYYY' ? 'MM/DD/YYYY' : 'DD/MM/YYYY'] }] : [] });
  const record = (answer: string) => {
    const original = [{ position: 0, inputName: 'a.csv', label: 'a', format: 'csv' as const, sourceSha256: SHA, tables: [dates('DD/MM/YYYY', true)] }];
    const index = buildTableIndex(original);
    const findings = classifyFindings(index.map((entry) => entry.table)).required;
    expect(findings.map((finding) => finding.findingKey)).toEqual(['0:when:ambiguous_date_format']);
    return recordRules([{ findingKey: findings[0]!.findingKey, answer, question: findings[0]!.question }], findings, index);
  };
  const evaluate = (answer: string, next: TableProfile) => {
    const index = buildTableIndex([{ position: 0, inputName: 'b.csv', label: 'b', format: 'csv', sourceSha256: SHA, tables: [next] }]);
    return evaluateRules(record(answer), classifyFindings(index.map((entry) => entry.table)).required, index);
  };

  it('applies a recorded day-first choice to a new ambiguous column', () => {
    const result = evaluate('DD/MM/YYYY', dates('MM/DD/YYYY', true));
    expect([result.applied.length, result.notNeeded.length, result.conflicts.length, result.unrecorded.length]).toEqual([1, 0, 0, 0]);
  });
  it('conflicts with a new unambiguous month-first column', () => {
    const result = evaluate('DD/MM/YYYY', dates('MM/DD/YYYY', false));
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.finding!.options.map((option) => option.value)).toEqual(['DD/MM/YYYY', 'MM/DD/YYYY']);
  });
  it('is not needed for an unambiguous day-first or ISO column', () => {
    expect(evaluate('DD/MM/YYYY', dates('DD/MM/YYYY', false)).notNeeded).toHaveLength(1);
    expect(evaluate('DD/MM/YYYY', dates('YYYY-MM-DD', false)).notNeeded).toHaveLength(1);
  });
  it('leaves ragged rows with no rule unrecorded, and rekeys a rule onto the new file', () => {
    const ragged = csvTable(BASE, { raggedRowCount: 3, notes: [{ code: 'ragged_rows', count: 3 }] });
    expect(evaluate('DD/MM/YYYY', ragged).unrecorded.map((finding) => finding.findingKey)).toEqual(['0:0:ragged_rows']);
    const index = buildTableIndex([{ position: 0, inputName: 'b.csv', label: 'b', format: 'csv', sourceSha256: SHA, tables: [dates('DD/MM/YYYY', true)] }]);
    expect(rekeyRules(record('MM/DD/YYYY'), index)).toEqual({ '0:when:ambiguous_date_format': 'MM/DD/YYYY' });
  });
  it('records a declined question with its applied default', () => {
    const index = buildTableIndex([{ position: 0, inputName: 'a.csv', label: 'a', format: 'csv', sourceSha256: SHA, tables: [dates('DD/MM/YYYY', true)] }]);
    const findings = classifyFindings(index.map((entry) => entry.table)).required;
    const declined: RuleAnswer = { findingKey: findings[0]!.findingKey, answer: null, proposedDefault: 'DD/MM/YYYY', question: 'Q', status: 'declined' };
    expect(recordRules([declined], findings, index)).toEqual([expect.objectContaining({ answer: 'DD/MM/YYYY', column: 'when' })]);
  });
  it('reproduces the classifier keys for two files and three sheets', () => {
    const inputs = [
      { position: 0, inputName: 'a.xlsx', label: 'a', format: 'xlsx' as const, sourceSha256: SHA, tables: [sheet('S1', 0, [temporal('d', 0, 'DD/MM/YYYY', true)], { notes: [{ code: 'ambiguous_date_format', column: 'd', formats: ['DD/MM/YYYY', 'MM/DD/YYYY'] }] }), sheet('S2', 1, [col('x', 0)], { notes: [{ code: 'merged_cells', count: 2 }] })] },
      { position: 1, inputName: 'b.csv', label: 'b', format: 'csv' as const, sourceSha256: SHA, tables: [csvTable([col('y', 0)], { notes: [{ code: 'ragged_rows', count: 1 }] })] },
    ];
    const index = buildTableIndex(inputs);
    expect(index.map((entry) => [entry.profileIndex, entry.inputPosition, entry.sheetName])).toEqual([[0, 0, 'S1'], [1, 0, 'S2'], [2, 1, null]]);
    const findings = classifyFindings(index.map((entry) => entry.table)).required;
    expect(findings.map((finding) => finding.findingKey).sort()).toEqual(['0:d:ambiguous_date_format', '0:sheet:multiple_sheets', '2:0:ragged_rows']);
    // Each key's profile index points back at the file and sheet it came from.
    expect(findings.map((finding) => [finding.findingKey, index[finding.profileIndex]!.inputPosition]).sort()).toEqual([['0:d:ambiguous_date_format', 0], ['0:sheet:multiple_sheets', 0], ['2:0:ragged_rows', 1]]);
  });
});

describe('mapping: validation and the sentences sent to the AI', () => {
  const contract = contractFor([csvTable(BASE)]);
  const report = check(contract, [{ tables: [csvTable([BASE[0]!, col('Total', 1), BASE[2]!])] }]);
  const tables = [{ inputPosition: 0, table: csvTable([BASE[0]!, col('Total', 1), BASE[2]!]) }];
  const valid: RepairMapping = { columns: [{ inputPosition: 0, sheet: null, expected: 'amount', use: 'Total' }], sheets: [], decisions: [], note: null };

  it('accepts one choice per blocker and refuses anything else, naming the item', () => {
    expect(() => validateMapping(valid, report, tables)).not.toThrow();
    expect(() => validateMapping({ ...valid, columns: [] }, report, tables)).toThrow('every missing item');
    expect(() => validateMapping({ ...valid, columns: [{ ...valid.columns[0]!, use: 'Nowhere' }] }, report, tables)).toThrow('Nowhere');
    expect(() => validateMapping({ ...valid, columns: [{ ...valid.columns[0]!, expected: 'region' }] }, report, tables)).toThrow('region');
    expect(() => validateMapping({ ...valid, columns: [valid.columns[0]!, valid.columns[0]!] }, report, tables)).toThrow();
    expect(() => validateMapping({ ...valid, note: 'x'.repeat(100_000) }, report, tables)).toThrow('too long');
    expect(() => validateMapping({ ...valid, decisions: [{ findingKey: '0:when:ambiguous_date_format', answer: 'x' }] }, report, tables)).toThrow();
  });

  it('renders fixed sentences that name files by position, never by filename', () => {
    const text = renderMappingInstructions({ columns: [{ inputPosition: 0, sheet: null, expected: 'Amount', use: 'Total' }, { inputPosition: 0, sheet: null, expected: 'Region', use: null }], sheets: [{ inputPosition: 0, expected: 'Sep', use: 'Oct' }], decisions: [{ findingKey: '0:when:ambiguous_date_format', answer: 'DD/MM/YYYY' }, { findingKey: '0:0:ragged_rows', answer: 'skip' }], note: 'Totals are in thousands.' }, contract);
    expect(text.split('\n')).toEqual([
      REPAIR_INSTRUCTIONS_PREFACE,
      'In the first file, use the column “Total” wherever the saved task used “Amount”.',
      'In the first file, the column “Region” no longer exists; do the task without it.',
      'In the first file, the sheet “Oct” is the one the saved task called “Sep”.',
      'For the column “when” (how its dates are read), use “DD/MM/YYYY”.',
      'For rows with a different number of fields, use “skip”.',
      'Totals are in thousands.',
    ]);
    expect(text).not.toContain('sales.csv');
    expect(text).not.toMatch(/ambiguous_date_format|ragged_rows|0:/);
  });
});

describe('wording', () => {
  const finding = (code: CompatibilityFinding['code']): CompatibilityFinding => ({ code, severity: 'info', inputPosition: 0, sheet: 'Sheet1', column: 'Amount', expected: 'integer', found: 'string', suggestion: null });
  it.each([...COMPATIBILITY_FINDING_CODES])('%s has a headline in work terms', (code) => {
    const words = describeCompatibilityFinding(finding(code));
    expect(words.headline.length).toBeGreaterThan(0);
    for (const identifier of COMPATIBILITY_FINDING_CODES) { expect(words.headline).not.toContain(identifier); expect(words.detail).not.toContain(identifier); }
  });
  it('formats dates and as-of lines independently of the locale', () => {
    expect(formatCalendarDate('2026-09-25')).toBe('25 Sep 2026');
    expect(describeAsOf({ date: '2026-09-25', timeZone: 'Europe/London', source: 'now' })).toBe('As of 25 Sep 2026 · Europe/London');
    expect(describeAsOf({ date: '2026-09-25', timeZone: 'Europe/London', source: 'chosen' })).toBe('As of 25 Sep 2026 · Europe/London · the date you chose');
    expect(describeAsOf({ date: '2026-09-25', timeZone: 'UTC', source: 'copied' })).toBe('As of 25 Sep 2026 · UTC · the same date as the run it repeats');
    expect(describeColumnType('decimal')).toBe('numbers');
    expect(describeColumnType('date')).toBe('dates');
  });
  it('labels every trigger and reuse kind without an error code', () => {
    for (const trigger of ['manual', 'rerun', 'feedback'] as const) for (const reuseKind of [null, ...REUSE_KINDS]) for (const hasGuidance of [true, false]) {
      const label = describeTrigger(trigger, { hasGuidance, reuseKind });
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toMatch(/[A-Z]{3,}_[A-Z]/);
    }
    expect(describeTrigger('manual', { hasGuidance: false, reuseKind: 'run' })).toBe('Ran your saved task');
    expect(describeTrigger('rerun', { hasGuidance: false, reuseKind: 'replay' })).toBe('Ran again exactly');
    expect(describeTrigger('rerun', { hasGuidance: true, reuseKind: 'repair' })).toBe('Repaired with AI');
  });
});

describe('FEAT-111 state, kinds, clock scan, and code contract', () => {
  it('adds exactly one edge: pending → verifying, for a saved task\'s run', () => {
    expect(TRANSITIONS.pending).toEqual(['generating', 'verifying', 'failed', 'aborted']);
    expect([REUSE_KINDS.filter((kind) => isSavedCodeRun(kind)), isSavedCodeRun(null), isSavedCodeRun(undefined)]).toEqual([['run', 'replay'], false, false]);
  });
  it('finds each clock pattern with its line, reports a commented call, and ignores tests', () => {
    const lines = ['datetime.now()', 'datetime.today()', 'datetime.utcnow()', 'date.today()', 'pd.Timestamp.now()', 'pandas.Timestamp.today()', "pd.to_datetime('now')", 'np.datetime64("today")', 'time.localtime()', "time.strftime('%Y')", '# no datetime.now() here'];
    expect(findWallClockReads([{ path: 'main.py', role: 'script', content: lines.join('\n') }]).map((read) => read.line)).toEqual(lines.map((_, index) => index + 1));
    expect(findWallClockReads([{ path: 'test_main.py', role: 'test', content: lines.join('\n') }])).toEqual([]);
    expect(findWallClockReads([{ path: 'util.py', role: 'support', content: 'x = 1\ny = date.today()' }])).toEqual([{ path: 'util.py', line: 2, pattern: expect.any(String) }]);
    expect(findWallClockReads([{ path: 'main.py', role: 'script', content: 'import os\nprint(os.environ["AUTOMATE_AS_OF_DATE"])' }])).toEqual([]);
  });
  it('renders rules 7 and 8 verbatim in the code contract', () => {
    const text = renderCodeContract({ platform: 'linux', pythonVersion: '3.14.6', dependencies: [], inputFiles: [], attemptLimit: 3 });
    expect(text).toContain(`7. ${AS_OF_RULE}`);
    expect(text).toContain(`8. ${RERUNNABLE_TESTS_RULE}`);
    expect(AS_OF_RULE).toContain('AUTOMATE_AS_OF_DATE');
    expect(RERUNNABLE_TESTS_RULE).toBe('Tests must compute the results they expect from the input they read, never from literal values in the sample rows, so this task can be checked again against another file.');
  });
});
