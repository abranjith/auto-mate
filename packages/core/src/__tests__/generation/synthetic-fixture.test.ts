import { describe, expect, it } from 'vitest';
import { buildSyntheticFixture } from '../../generation/synthetic-fixture';
import { buildDisclosurePayload } from '../../ingestion/disclosure-payload';
import { column, table, upload } from '../ingestion/profile-fixtures';
import { REAL_FILE_ROWS, ROW_11_SENTINEL, SALES_SAMPLES, matrixProfile, salesProfile } from './synthetic-profiles';

const OPTIONS = { rowCount: 200, seed: 'seed-a' };
const columnValues = (rows: string[][], index: number, from = 0) => rows.slice(from).map((row) => row[index]!);
const serialize = (value: unknown) => JSON.stringify(value);

describe('buildSyntheticFixture', () => {
  it('is deterministic: the same profile and seed yield identical output, a different seed differs', () => {
    const first = buildSyntheticFixture(salesProfile(), OPTIONS);
    expect(buildSyntheticFixture(salesProfile(), OPTIONS)).toEqual(first);
    expect(serialize(buildSyntheticFixture(salesProfile(), { ...OPTIONS, seed: 'seed-b' }))).not.toBe(serialize(first));
  });

  it('builds the header in position order, then the sample rows verbatim, then synthesized rows to the requested count', () => {
    const profile = salesProfile({ columns: [...salesProfile().columns].reverse() });
    const built = buildSyntheticFixture(profile, OPTIONS);
    expect(built.header).toEqual(['order_id', 'region', 'amount', 'day', 'paid', 'note']);
    expect(built.sampleRowCount).toBe(10);
    expect(built.rows.slice(0, 10)).toEqual(SALES_SAMPLES);
    expect(built.rows).toHaveLength(200);
    expect(built.rows.every((row) => row.length === 6)).toBe(true);
  });

  it('keeps integers and decimals inside their bounds at the observed scale', () => {
    const built = buildSyntheticFixture(salesProfile(), OPTIONS);
    for (const cell of columnValues(built.rows, 2, 10).filter(Boolean)) {
      expect(cell).toMatch(/^\d+\.\d{2}$/);
      expect(Number(cell)).toBeGreaterThanOrEqual(0);
      expect(Number(cell)).toBeLessThanOrEqual(100);
    }
    for (const cell of columnValues(built.rows, 0, 10).filter(Boolean)) {
      expect(cell).toMatch(/^\d+$/);
      expect(Number(cell)).toBeGreaterThanOrEqual(1001);
      expect(Number(cell)).toBeLessThanOrEqual(6000);
    }
  });

  it('keeps dates inside their range and renders them in the detected format', () => {
    const built = buildSyntheticFixture(salesProfile(), OPTIONS);
    for (const cell of columnValues(built.rows, 3, 10).filter(Boolean)) {
      const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(cell);
      expect(match).not.toBeNull();
      const [, day, month, year] = match!;
      expect(`${year}-${month}`).toBe('2026-03');
      expect(Number(day)).toBeGreaterThanOrEqual(1);
      expect(Number(day)).toBeLessThanOrEqual(31);
    }
  });

  it('renders datetimes and workbook-native dates in their own patterns', () => {
    const datetime = column({ inferredType: 'datetime', name: 'at', stats: { kind: 'temporal', min: '2026-01-01T08:00:00', max: '2026-01-01T09:00:00', detectedFormat: 'MM/DD/YYYY HH:mm:ss', ambiguous: false, alternateFormat: null }, topValues: null, isHighCardinality: true, distinctCount: null });
    const native = column({ position: 1, inferredType: 'date', name: 'on', stats: { kind: 'temporal', min: '2026-02-01', max: '2026-02-03', detectedFormat: 'excel-native', ambiguous: false, alternateFormat: null }, topValues: null });
    const built = buildSyntheticFixture(table({ columns: [datetime, native], columnCount: 2, sampleRows: [] }), { rowCount: 50, seed: 'x' });
    for (const [at, on] of built.rows) {
      expect(at).toMatch(/^01\/01\/2026 0[89]:\d{2}:\d{2}$/);
      expect(on).toMatch(/^2026-02-0[123]$/);
    }
  });

  it('honors an empty-cell rate of 0.25 within ±0.1 over 200 rows', () => {
    const rate = column({ inferredType: 'integer', nullCount: 50, blankCount: 0, valueCount: 150, topValues: null, isHighCardinality: true, distinctCount: null, stats: { kind: 'numeric', min: 0, max: 1_000_000, mean: 1, stddev: 1, median: 1, p25: 1, p75: 1, approximate: false } });
    const built = buildSyntheticFixture(table({ columns: [rate], sampleRows: [] }), OPTIONS);
    const empty = built.rows.filter(([cell]) => cell === '').length / built.rows.length;
    expect(Math.abs(empty - 0.25)).toBeLessThanOrEqual(0.1);
  });

  it('leaves an empty column empty and draws booleans only from the observed literals', () => {
    const built = buildSyntheticFixture(salesProfile({ columns: [...salesProfile().columns, column({ position: 6, name: 'blank', inferredType: 'empty', stats: null, topValues: null })] }), OPTIONS);
    expect(columnValues(built.rows, 6).every((cell) => cell === '')).toBe(true);
    expect(new Set(columnValues(built.rows, 4, 10).filter(Boolean))).toEqual(new Set(['TRUE', 'FALSE']));
  });

  it('draws a low-cardinality column only from its disclosed frequent values, in proportion', () => {
    const built = buildSyntheticFixture(salesProfile(), OPTIONS);
    const regions = columnValues(built.rows, 1, 10);
    expect(new Set(regions).size).toBeLessThanOrEqual(4);
    for (const value of regions) expect(['North', 'South', 'East', 'West']).toContain(value);
    expect(regions.filter((value) => value === 'North').length).toBeGreaterThan(regions.filter((value) => value === 'West').length);
  });

  it('never reuses a disclosed or sample value in a high-cardinality column', () => {
    const profile = salesProfile();
    const built = buildSyntheticFixture(profile, OPTIONS);
    const disclosed = new Set([...profile.sampleRows.flat(), ...profile.columns.flatMap(({ topValues }) => topValues?.map(({ value }) => value) ?? [])]);
    for (const index of [0, 2, 5]) {
      const synthesized = new Set(columnValues(built.rows, index, 10).filter(Boolean));
      expect([...synthesized].filter((value) => disclosed.has(value))).toEqual([]);
    }
  });

  it('never contains a value from row 11 of the real file (the central test)', () => {
    const profile = salesProfile();
    expect(serialize(REAL_FILE_ROWS)).toContain(ROW_11_SENTINEL);
    for (const seed of ['a', 'b', 'c', 'd']) expect(serialize(buildSyntheticFixture(profile, { rowCount: 500, seed }))).not.toContain(ROW_11_SENTINEL);
  });

  it('never contains the sentinel across a generated matrix of 50 profiles, built from the disclosure payload too', () => {
    for (let index = 0; index < 50; index += 1) {
      const profile = matrixProfile(index);
      const payload = buildDisclosurePayload(upload(), [profile]);
      for (const source of [profile, payload.tables[0]!]) {
        const built = buildSyntheticFixture(source, { rowCount: 200, seed: `m${index}` });
        expect(serialize(built)).not.toContain(ROW_11_SENTINEL);
        expect(built.rows).toHaveLength(200);
        expect(built.rows.slice(0, built.sampleRowCount)).toEqual(profile.sampleRows);
      }
    }
  });

  it('builds 512 columns by 200 rows in under a second', () => {
    const columns = Array.from({ length: 512 }, (_, position) => matrixProfile(position).columns[0]!).map((entry, position) => ({ ...entry, position, name: `col${position}` }));
    const started = performance.now();
    const built = buildSyntheticFixture(table({ columns, columnCount: 512, sampleRows: [] }), OPTIONS);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(built.rows).toHaveLength(200);
    expect(built.header).toHaveLength(512);
  });

  it('produces a valid table for zero columns, zero sample rows, and one row', () => {
    expect(buildSyntheticFixture(table({ columns: [], columnCount: 0, sampleRows: [] }), OPTIONS)).toEqual({ header: [], rows: [], sampleRowCount: 0 });
    const noSamples = buildSyntheticFixture(salesProfile({ sampleRows: [] }), OPTIONS);
    expect(noSamples.sampleRowCount).toBe(0);
    expect(noSamples.rows).toHaveLength(200);
    const one = buildSyntheticFixture(salesProfile(), { rowCount: 1, seed: 's' });
    expect(one.rows).toEqual([SALES_SAMPLES[0]]);
    expect(one.sampleRowCount).toBe(1);
    expect(buildSyntheticFixture(salesProfile(), { rowCount: 0, seed: 's' }).rows).toEqual([]);
  });

  it('pads a ragged sample row to the column count rather than shifting cells', () => {
    const built = buildSyntheticFixture(salesProfile({ sampleRows: [['1001', 'North']] }), { rowCount: 3, seed: 's' });
    expect(built.rows[0]).toEqual(['1001', 'North', '', '', '', '']);
  });

  it('works from a disclosed table whose frequent values were dropped by the degradation ladder', () => {
    const payload = buildDisclosurePayload(upload(), [salesProfile()]);
    const stripped = { ...payload.tables[0]!, columns: payload.tables[0]!.columns.map((entry) => ({ ...entry, topValues: null })) };
    const built = buildSyntheticFixture(stripped, OPTIONS);
    expect(built.rows).toHaveLength(200);
    expect(serialize(built)).not.toContain(ROW_11_SENTINEL);
  });
});
