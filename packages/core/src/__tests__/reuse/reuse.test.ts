import { describe, expect, it } from 'vitest';
import { INFERRED_TYPES } from '../../contracts/upload-api';
import { table, column } from '../ingestion/profile-fixtures';
import { asOfEnvironment, resolveAsOf } from '../../reuse/as-of';
import { buildInputContract, contractDigest } from '../../reuse/input-contract';
import { TYPE_COMPATIBILITY } from '../../reuse/type-compatibility';
import { findWallClockReads } from '../../reuse/wall-clock-scan';
import { buildTableIndex, dayFirstOf, parseFindingKey } from '../../reuse/rules';
import { checkCompatibility } from '../../reuse/compatibility';

const SHA = 'a'.repeat(64);
const input = (tables = [table()]) => ({ position: 0, inputName: '12-sales.csv', label: 'sales.csv', format: 'csv' as const, sourceSha256: SHA, tables });
const source = () => ({ inputs: [input()], declaredInputs: [{ fileRole: '12-sales.csv', requiredColumns: [{ name: 'amount', type: 'integer' as const }] }] });
const context = () => ({ templateId: 1, revisionNumber: 1, revisionRuntime: { fingerprint: SHA, detail: { pythonVersion: '3.14.6', uvVersion: '1', platform: 'linux', arch: 'x64', packages: [] } }, currentRuntime: { fingerprint: SHA, detail: { pythonVersion: '3.14.6', uvVersion: '1', platform: 'linux', arch: 'x64', packages: [] } }, readsWallClock: false, asOf: resolveAsOf({ nowMs: Date.UTC(2026, 8, 26), timeZone: 'UTC' }) });

describe('reuse contracts', () => {
  it('keeps shape but excludes sample values and top values', () => {
    const sensitive = table({ sampleRows: [['CELL_SENTINEL']], columns: [column({ topValues: [{ value: 'TOP_SENTINEL', count: 1 }] })] });
    const contract = buildInputContract({ ...source(), inputs: [input([sensitive])] });
    expect(contract.inputs[0]?.tables[0]?.columns[0]).toMatchObject({ name: 'amount', required: true, declaredType: 'integer' });
    expect(JSON.stringify(contract)).not.toMatch(/CELL_SENTINEL|TOP_SENTINEL/);
    expect(contractDigest(contract)).toBe(contractDigest(structuredClone(contract)));
    expect(contractDigest({ ...contract, notes: [{ question: 'Q', answer: 'A' }] })).not.toBe(contractDigest(contract));
    expect(() => buildInputContract({ ...source(), inputs: [input([table({ columns: [column({ name: 'other' })] })])] })).toThrow('amount');
  });

  it('defines every type pair and blocks text in numeric columns', () => {
    expect(Object.keys(TYPE_COMPATIBILITY)).toEqual([...INFERRED_TYPES]);
    for (const expected of INFERRED_TYPES) expect(Object.keys(TYPE_COMPATIBILITY[expected])).toEqual([...INFERRED_TYPES]);
    expect(TYPE_COMPATIBILITY.decimal.string).toBe('blocking');
    expect(TYPE_COMPATIBILITY.integer.decimal).toBe('advisory');
  });

  it('handles positional keys without confusing a numeric column with a sheet', () => {
    expect(parseFindingKey('0:a:b:ambiguous_date_format')).toMatchObject({ column: 'a:b', kind: 'ambiguous_date_format' });
    expect(parseFindingKey('1:0:mixed_type_column')).toMatchObject({ column: '0', sheetIndex: null });
    expect(dayFirstOf('DD/MM/YYYY')).toBe(true);
    expect(dayFirstOf('MM/DD/YYYY')).toBe(false);
    expect(dayFirstOf('YYYY-MM-DD')).toBeNull();
    expect(buildTableIndex([input()])[0]?.profileIndex).toBe(0);
  });

  it('finds direct clock reads in scripts and ignores tests', () => {
    const reads = findWallClockReads([{ path: 'main.py', role: 'script', content: '# date.today()\nprint(datetime.now())' }, { path: 'test_main.py', role: 'test', content: 'date.today()' }]);
    expect(reads.map(({ line }) => line)).toEqual([1, 2]);
  });

  it('reports a renamed required column, then a compatible shape', () => {
    const contract = buildInputContract(source());
    const renamed = table({ columns: [column({ name: 'Amount' })] });
    const candidate = { inputs: [{ position: 0, uploadId: 30, label: 'next.csv', format: 'csv' as const, tables: [renamed] }], findings: [], tableIndex: buildTableIndex([{ ...input([renamed]), uploadId: 30 }]) };
    const report = checkCompatibility(contract, candidate, context());
    expect(report.status).toBe('incompatible');
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'column_missing', suggestion: 'Amount' }));
    expect(JSON.stringify(report)).not.toContain('CELL_SENTINEL');
    const compatible = checkCompatibility(contract, { ...candidate, inputs: [{ ...candidate.inputs[0]!, tables: [table()] }] }, context());
    expect(compatible.status).toBe('compatible');
  });
});

describe('as-of', () => {
  it.each(['UTC', 'Europe/London', 'America/New_York', 'Asia/Kolkata'])('resolves now in %s', (timeZone) => {
    const at = Date.UTC(2026, 8, 26, 12);
    expect(resolveAsOf({ nowMs: at, timeZone }).at).toBe(Math.floor(at / 1000));
  });

  it.each([['Europe/London', '2026-03-28'], ['Europe/London', '2026-03-29'], ['America/New_York', '2026-10-31'], ['America/New_York', '2026-11-01']])('ends %s %s at the last local second', (timeZone, chosenDate) => {
    const value = resolveAsOf({ nowMs: Date.UTC(2026, 11, 1), timeZone, chosenDate });
    expect(asOfEnvironment(value).AUTOMATE_AS_OF).toMatch(new RegExp(`^${chosenDate}T23:59:59`));
  });

  it('formats half-hour offsets and rejects bad dates and zones', () => {
    const value = resolveAsOf({ nowMs: Date.UTC(2026, 8, 26), timeZone: 'Asia/Kolkata' });
    expect(asOfEnvironment(value).AUTOMATE_AS_OF).toContain('+05:30');
    for (const chosenDate of ['2026-02-30', 'not-a-date', '2027-01-01']) expect(() => resolveAsOf({ nowMs: Date.UTC(2026, 8, 26), timeZone: 'UTC', chosenDate })).toThrow();
    expect(() => resolveAsOf({ nowMs: Date.now(), timeZone: 'Mars/Olympus' })).toThrow();
  });
});
