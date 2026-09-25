// Shared test support for the synthetic-fixture suites: literal profiles the
// builder is exercised against. Not a test file, so it registers no `describe`.
import type { ColumnProfile, TableProfile } from '../../contracts/upload-api';
import { column, table } from '../ingestion/profile-fixtures';

/** A sentinel that exists only in "row 11" of the pretend real file. */
export const ROW_11_SENTINEL = 'ZQX-ROW-ELEVEN-SENTINEL-7f3a';

/** Ten verbatim sample rows for a sales table: id, region, amount, day, paid, note. */
export const SALES_SAMPLES: string[][] = Array.from({ length: 10 }, (_, index) => [
  String(1001 + index),
  ['North', 'South', 'East', 'West'][index % 4]!,
  (12.5 + index).toFixed(2),
  `0${(index % 9) + 1}/03/2026`,
  index % 2 === 0 ? 'TRUE' : 'FALSE',
  `note ${index}`,
]);

/** The pretend real file: the ten sample rows, then row 11 holding the sentinel, then more. */
export const REAL_FILE_ROWS: string[][] = [...SALES_SAMPLES, ['1011', 'North', '99.00', '11/03/2026', 'TRUE', ROW_11_SENTINEL], ['1012', 'South', '1.00', '12/03/2026', 'FALSE', 'late']];

/** A realistic six-column sales profile whose sample rows are rows 1–10 of `REAL_FILE_ROWS`. */
export function salesProfile(overrides: Partial<TableProfile> = {}): TableProfile {
  const columns: ColumnProfile[] = [
    column({ position: 0, name: 'order_id', inferredType: 'integer', valueCount: 5000, distinctCount: null, isHighCardinality: true, topValues: null, stats: { kind: 'numeric', min: 1001, max: 6000, mean: 3500, stddev: 1400, median: 3500, p25: 2250, p75: 4750, approximate: true } }),
    column({ position: 1, name: 'region', inferredType: 'string', valueCount: 5000, distinctCount: 4, topValues: [{ value: 'North', count: 2000 }, { value: 'South', count: 1500 }, { value: 'East', count: 1000 }, { value: 'West', count: 500 }], stats: { kind: 'string', minLength: 4, maxLength: 5, meanLength: 4.6 } }),
    column({ position: 2, name: 'amount', inferredType: 'decimal', valueCount: 5000, distinctCount: null, isHighCardinality: true, topValues: null, stats: { kind: 'numeric', min: 0, max: 100, mean: 50, stddev: 20, median: 50, p25: 25, p75: 75, approximate: true } }),
    column({ position: 3, name: 'day', inferredType: 'date', valueCount: 5000, distinctCount: 31, topValues: null, stats: { kind: 'temporal', min: '2026-03-01', max: '2026-03-31', detectedFormat: 'DD/MM/YYYY', ambiguous: false, alternateFormat: null } }),
    column({ position: 4, name: 'paid', inferredType: 'boolean', valueCount: 5000, distinctCount: 2, topValues: null, stats: null }),
    column({ position: 5, name: 'note', inferredType: 'string', valueCount: 3750, nullCount: 1250, distinctCount: null, isHighCardinality: true, topValues: null, stats: { kind: 'string', minLength: 3, maxLength: 20, meanLength: 8 } }),
  ];
  return table({ rowCount: 5000, columnCount: columns.length, columns, sampleRows: SALES_SAMPLES, ...overrides });
}

/**
 * A varied profile for matrix tests, deterministic in its index.
 *
 * @param index Which variant; column types, counts, and sample sizes all vary with it.
 */
export function matrixProfile(index: number): TableProfile {
  const width = 1 + (index % 7);
  const types = ['integer', 'decimal', 'string', 'date', 'datetime', 'boolean', 'empty'] as const;
  const columns = Array.from({ length: width }, (_, position) => {
    const type = types[(index + position) % types.length]!;
    const high = (index + position) % 3 === 0;
    const stats = type === 'integer' || type === 'decimal'
      ? { kind: 'numeric' as const, min: -index, max: index * 10 + 5, mean: 0, stddev: null, median: 0, p25: 0, p75: 0, approximate: false }
      : type === 'date' || type === 'datetime'
        ? { kind: 'temporal' as const, min: '2025-01-01', max: '2026-12-31T23:59:59', detectedFormat: type === 'date' ? 'YYYY-MM-DD' : 'YYYY-MM-DD HH:mm:ss', ambiguous: false, alternateFormat: null }
        : type === 'string' ? { kind: 'string' as const, minLength: 1, maxLength: 30, meanLength: 10 } : null;
    return column({ position, name: `c${position}`, inferredType: type, valueCount: 100, nullCount: index % 4, isHighCardinality: high, distinctCount: high ? null : 3, stats, topValues: high || type !== 'string' ? null : [{ value: `v${index}a`, count: 3 }, { value: `v${index}b`, count: 1 }] });
  });
  const samples = Array.from({ length: index % 11 }, (_, row) => columns.map((entry) => `s${row}-${entry.name}`));
  return table({ rowCount: 100, columnCount: width, columns, sampleRows: samples });
}
