import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { DisclosurePayloadSchema, type ColumnProfile, type TableProfile } from '../../contracts/upload-api';
import {
  buildDisclosurePayload,
  estimatePayloadBytes,
  MAX_NOTES_PER_TABLE,
  utf8ByteLength,
  type DisclosureUpload,
} from '../../ingestion/disclosure-payload';
import { DISCLOSURE_MAX_BYTES } from '../../ingestion/limits';
import { seededRandom } from '../../ingestion/seeded-random';
import { column, SHA, table } from './profile-fixtures';

const upload: DisclosureUpload = { originalFilename: 'sales-q3.csv', format: 'csv', byteSize: 1234, sha256: SHA, encoding: 'utf-8' };
const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** A wide table with long names, long top values, and full sample rows. */
function wideTable(columns: number, nameLength: number, sheetIndex = 0): TableProfile {
  const name = (position: number) => `${'n'.repeat(nameLength)}_${position}`;
  const cols: ColumnProfile[] = Array.from({ length: columns }, (_, position) =>
    column({
      position,
      name: name(position),
      topValues: Array.from({ length: 5 }, (_, rank) => ({ value: `${'v'.repeat(150)}${rank}`, count: 5 - rank })),
    }),
  );
  const sampleRows = Array.from({ length: 10 }, () => Array.from({ length: columns }, () => 's'.repeat(120)));
  return table({ sheetIndex, sheetName: `Sheet ${sheetIndex}`, columns: cols, columnCount: columns, sampleRows });
}

describe('buildDisclosurePayload', () => {
  it('produces a small schema-valid payload with no truncations', () => {
    const payload = buildDisclosurePayload(upload, [table()]);
    expect(Value.Errors(DisclosurePayloadSchema, payload).First()).toBeUndefined();
    expect(payload.truncations).toEqual([]);
    expect(payload.file).toEqual({ name: 'sales-q3.csv', format: 'csv', byteSize: 1234, sha256: SHA, encoding: 'utf-8' });
    expect(payload.tables[0]!.columns[0]!.topValues).toEqual([{ value: '1', count: 1 }]);
  });

  it('degrades a 512-column table through the ladder in the documented order, recording every step', () => {
    const payload = buildDisclosurePayload(upload, [wideTable(512, 150)]);
    const steps = payload.truncations.map(({ step }) => step);
    expect(steps[0]).toBe('drop_top_values');
    expect(steps).toContain('reduce_sample_rows');
    expect(steps.at(-1)).toBe('truncate_columns');
    const order = ['limit_notes', 'drop_top_values', 'reduce_sample_rows', 'drop_sample_rows', 'truncate_columns', 'omit_tables'];
    expect(steps.map((step) => order.indexOf(step))).toEqual([...steps.map((step) => order.indexOf(step))].sort((a, b) => a - b));
    const truncated = payload.truncations.find(({ step }) => step === 'truncate_columns')!;
    expect(truncated.kept! + truncated.omitted!).toBe(512);
    expect(payload.tables[0]!.omittedColumnCount).toBe(truncated.omitted);
    expect(payload.tables[0]!.sampleRows[0]).toHaveLength(truncated.kept!);
    expect(estimatePayloadBytes(payload)).toBeLessThanOrEqual(DISCLOSURE_MAX_BYTES);
  });

  it('drops top values from the largest table first and stops as soon as it fits', () => {
    const small = wideTable(3, 10, 0);
    const large = wideTable(20, 10, 1);
    expect(bytesOf(buildDisclosurePayload(upload, [small, large]))).toBeLessThan(DISCLOSURE_MAX_BYTES);
    const payload = buildDisclosurePayload(upload, [small, large], { maxBytes: bytesOf(buildDisclosurePayload(upload, [small, large])) - 1 });
    expect(payload.truncations).toEqual([{ step: 'drop_top_values', sheetIndex: 1 }]);
    expect(payload.tables[0]!.columns[0]!.topValues).not.toBeNull();
  });

  it('reduces sample rows toward three, then drops them from all but the first table', () => {
    const tables = [wideTable(40, 5, 0), wideTable(40, 5, 1)].map((profile) => ({
      ...profile,
      columns: profile.columns.map((col) => ({ ...col, topValues: null })),
    }));
    const full = bytesOf(buildDisclosurePayload(upload, tables));
    const payload = buildDisclosurePayload(upload, tables, { maxBytes: Math.floor(full * 0.3) });
    const steps = payload.truncations.map(({ step }) => step);
    expect(steps.slice(0, 2)).toEqual(['reduce_sample_rows', 'drop_sample_rows']);
    expect(payload.truncations[0]).toEqual({ step: 'reduce_sample_rows', kept: 3 });
    expect(payload.tables[1]?.sampleRows ?? []).toEqual([]);
  });

  it('is at or under the ceiling for every case in a generated matrix', () => {
    for (const tables of [1, 3, 20]) {
      for (const columns of [1, 40, 512]) {
        for (const length of [1, 60, 200]) {
          const profiles = Array.from({ length: tables }, (_, index) => wideTable(columns, length, index));
          const payload = buildDisclosurePayload(upload, profiles);
          expect(bytesOf(payload)).toBeLessThanOrEqual(DISCLOSURE_MAX_BYTES);
          expect(Value.Check(DisclosurePayloadSchema, payload)).toBe(true);
          // The arithmetic ladder settles on its own; the real-measurement backstop never acts.
          expect(payload.truncations.some(({ step }) => step === 'omit_tables')).toBe(false);
          expect(payload.tables).toHaveLength(tables);
        }
      }
    }
  });

  it('is deterministic: the same input yields a byte-identical payload', () => {
    const profiles = [wideTable(512, 150), wideTable(30, 20, 1)];
    expect(JSON.stringify(buildDisclosurePayload(upload, profiles))).toBe(JSON.stringify(buildDisclosurePayload(upload, profiles)));
  });

  it('never lets a high-cardinality column carry values, before or after degradation', () => {
    const leaky = column({ isHighCardinality: true, distinctCount: 50, topValues: [{ value: 'secret', count: 9 }] });
    for (const maxBytes of [DISCLOSURE_MAX_BYTES, 900]) {
      const payload = buildDisclosurePayload(upload, [table({ columns: [leaky] })], { maxBytes });
      expect(payload.tables[0]?.columns[0] ?? { topValues: null, distinctCount: null }).toMatchObject({ topValues: null, distinctCount: null });
      expect(JSON.stringify(payload)).not.toContain('secret');
    }
  });

  it('keeps every sample cell at or under 200 characters, even from an over-long input', () => {
    const payload = buildDisclosurePayload(upload, [table({ sampleRows: [['x'.repeat(5_000)]] })]);
    const cells = payload.tables.flatMap((t) => t.sampleRows.flat());
    expect(cells.every((cell) => cell.length <= 200)).toBe(true);
  });

  it('never carries a directory from a client-supplied filename', () => {
    for (const originalFilename of ['C:\\Users\\me\\Desktop\\sales.csv', '/home/me/sales.csv', 'C:\\fakepath\\sales.csv']) {
      const serialized = JSON.stringify(buildDisclosurePayload({ ...upload, originalFilename }, [table()]));
      expect(serialized).not.toMatch(/[A-Za-z]:\\\\|\/home\/|Users|fakepath/);
      expect(JSON.parse(serialized).file.name).toBe('sales.csv');
    }
  });

  it('describes the columns of a table with zero data rows', () => {
    const empty = table({ rowCount: 0, sampleRows: [], columns: [column({ inferredType: 'empty', valueCount: 0, stats: null, topValues: [], distinctCount: 0 })] });
    const payload = buildDisclosurePayload(upload, [empty]);
    expect(Value.Check(DisclosurePayloadSchema, payload)).toBe(true);
    expect(payload.tables[0]).toMatchObject({ rowCount: 0, sampleRows: [] });
    expect(payload.tables[0]!.columns).toHaveLength(1);
  });

  it('limits notes per table and records it', () => {
    const notes = Array.from({ length: MAX_NOTES_PER_TABLE + 7 }, () => ({ code: 'blank_rows' as const, count: 1 }));
    const payload = buildDisclosurePayload(upload, [table({ notes })]);
    expect(payload.tables[0]!.notes).toHaveLength(MAX_NOTES_PER_TABLE);
    expect(payload.truncations).toContainEqual({ step: 'limit_notes', sheetIndex: 0, kept: MAX_NOTES_PER_TABLE, omitted: 7 });
  });

  it('omits trailing tables only as a last resort, and records how many', () => {
    const profiles = Array.from({ length: 5 }, (_, index) => table({ sheetIndex: index, sheetName: 's'.repeat(200) }));
    const payload = buildDisclosurePayload(upload, profiles, { maxBytes: 2_500 });
    expect(bytesOf(payload)).toBeLessThanOrEqual(2_500);
    const omitted = payload.truncations.find(({ step }) => step === 'omit_tables');
    expect(omitted?.omitted).toBe(5 - payload.tables.length);
    expect(payload.tables.length).toBeGreaterThan(0);
  });

  it('orders tables by sheet index regardless of input order', () => {
    const payload = buildDisclosurePayload(upload, [table({ sheetIndex: 2 }), table({ sheetIndex: 0 })]);
    expect(payload.tables.map(({ sheetIndex }) => sheetIndex)).toEqual([0, 2]);
  });

  it('does not mutate its input profiles', () => {
    const profiles = [wideTable(512, 150)];
    const before = JSON.stringify(profiles);
    buildDisclosurePayload(upload, profiles);
    expect(JSON.stringify(profiles)).toBe(before);
  });
});

describe('fuzzed profiles', () => {
  const random = seededRandom('disclosure-fuzz');
  const pick = (max: number) => Math.floor(random() * max);
  const alphabet = [0x61, 0xe9, 0x6771, 0x1f600];
  const pool = Array.from({ length: 64 }, () => String.fromCodePoint(...Array.from({ length: 400 }, () => alphabet[pick(4)]!)));
  /** A random prefix of a pooled random string: varied lengths and scripts without generating megabytes per run. */
  const text = (max: number) => pool[pick(pool.length)]!.slice(0, pick(max));

  function fuzzColumn(position: number): ColumnProfile {
    const high = random() < 0.3;
    return column({
      position,
      name: text(300) || `c${position}`,
      originalName: random() < 0.2 ? text(300) : null,
      isHighCardinality: high,
      distinctCount: high ? null : pick(999),
      topValues: high ? null : Array.from({ length: pick(6) }, () => ({ value: text(200), count: 1 + pick(9) })),
      stats: random() < 0.5 ? { kind: 'string', minLength: 0, maxLength: pick(900), meanLength: random() * 10 } : null,
    });
  }

  function fuzzTable(sheetIndex: number): TableProfile {
    const width = pick(600);
    return table({
      sheetIndex,
      sheetName: text(40),
      columnCount: width,
      columns: Array.from({ length: width }, (_, position) => fuzzColumn(position)),
      sampleRows: Array.from({ length: pick(11) }, () => Array.from({ length: width }, () => text(220))),
      notes: Array.from({ length: pick(80) }, () => ({ code: 'mixed_type_column' as const, column: text(250), count: pick(50) })),
    });
  }

  it('holds the ceiling and never throws for 60 random profiles', () => {
    for (let run = 0; run < 60; run += 1) {
      const profiles = Array.from({ length: 1 + pick(6) }, (_, index) => fuzzTable(index));
      const payload = buildDisclosurePayload({ ...upload, originalFilename: text(400) }, profiles);
      expect(bytesOf(payload)).toBeLessThanOrEqual(DISCLOSURE_MAX_BYTES);
      expect(Value.Check(DisclosurePayloadSchema, payload)).toBe(true);
      expect(payload.truncations.some(({ step }) => step === 'omit_tables')).toBe(false);
    }
  });
});

describe('estimatePayloadBytes', () => {
  it('agrees exactly with the encoded length, including multi-byte and astral characters', () => {
    const payload = buildDisclosurePayload({ ...upload, originalFilename: 'données-東京-😀.csv' }, [wideTable(30, 12)]);
    expect(estimatePayloadBytes(payload)).toBe(bytesOf(payload));
  });

  it('counts UTF-8 bytes per character class', () => {
    expect(utf8ByteLength('a')).toBe(1);
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('東')).toBe(3);
    expect(utf8ByteLength('😀')).toBe(4);
    expect(utf8ByteLength('\ud800')).toBe(3);
  });
});
