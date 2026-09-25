import { describe, expect, it } from 'vitest';
import {
  TEMPORAL_PATTERNS,
  TypeTally,
  cellSourceType,
  cellText,
  classifyCell,
  matchTemporal,
  parseNumber,
  type CellValue,
} from '../../ingestion/type-inference';

function resolve(values: readonly CellValue[]) {
  const tally = new TypeTally();
  values.forEach((value) => tally.push(value));
  return tally.resolve();
}

const patternsOf = (text: string) =>
  TEMPORAL_PATTERNS.filter((_, index) => ((matchTemporal(text)?.mask ?? 0) & (1 << index)) !== 0);

describe('classifyCell', () => {
  it.each<[CellValue, string]>([
    [null, 'null'],
    ['', 'blank'],
    ['   ', 'blank'],
    ['42', 'integer'],
    ['-7', 'integer'],
    ['0', 'integer'],
    ['3.14', 'decimal'],
    ['-0.5', 'decimal'],
    ['.5', 'decimal'],
    ['1e5', 'decimal'],
    ['0012', 'string'],
    ['1.', 'string'],
    ['12345678901234567890', 'string'],
    ['1e999', 'string'],
    ['TRUE', 'boolean'],
    ['false', 'boolean'],
    ['yes', 'string'],
    ['2026-09-14', 'temporal'],
    ['2026-09-14T10:00:00Z', 'temporal'],
    ['2026-02-30', 'string'],
    ['n/a', 'string'],
    [42, 'integer'],
    [3.5, 'decimal'],
    [Number.NaN, 'string'],
    [1e200, 'string'],
    [true, 'boolean'],
    [new Date(Date.UTC(2026, 0, 1)), 'temporal'],
    [new Date(Number.NaN), 'null'],
  ])('classifies %j as %s', (value, kind) => expect(classifyCell(value)).toBe(kind));

  it('treats a leading zero as meaningful: a zip code is not a number', () => {
    expect(resolve(['0012', '0345', '9999']).inferredType).toBe('string');
  });
});

describe('matchTemporal', () => {
  it('reports both day/month and month/day when every part is 12 or less', () => {
    expect(patternsOf('03/04/2026')).toEqual(['DD/MM/YYYY', 'MM/DD/YYYY']);
  });

  it('reports only day/month when the first part exceeds 12', () => {
    expect(patternsOf('23/04/2026')).toEqual(['DD/MM/YYYY']);
    expect(patternsOf('04/23/2026')).toEqual(['MM/DD/YYYY']);
  });

  it('validates the calendar, including leap years', () => {
    expect(matchTemporal('2024-02-29')).not.toBeNull();
    expect(matchTemporal('2023-02-29')).toBeNull();
    expect(matchTemporal('2026-13-01')).toBeNull();
    expect(matchTemporal('31/04/2026')).toBeNull();
  });

  it('recognises datetime variants, 12-hour clocks, and zones', () => {
    expect(patternsOf('2026-09-14T10:00:00Z')).toEqual(['YYYY-MM-DDTHH:mm:ss']);
    expect(patternsOf('2026-09-14 10:00')).toEqual(['YYYY-MM-DD HH:mm:ss']);
    expect(matchTemporal('1/2/2026 3:45 PM')?.iso.get(TEMPORAL_PATTERNS.indexOf('DD/MM/YYYY HH:mm:ss'))).toBe('2026-02-01T15:45:00');
    expect(matchTemporal('2026-09-14T25:00')).toBeNull();
    expect(matchTemporal('1/2/2026 13:00 PM')).toBeNull();
  });

  it('requires two-digit month and day for dashed ISO dates', () => {
    expect(matchTemporal('2026-9-4')).toBeNull();
    expect(patternsOf('2026/9/4')).toEqual(['YYYY/MM/DD']);
  });
});

describe('TypeTally.resolve', () => {
  it('infers integer with confidence 1.0 for an all-integer column', () => {
    expect(resolve(['1', '2', '3'])).toMatchObject({ inferredType: 'integer', typeConfidence: 1, isMixedType: false });
  });

  it('keeps integer at 0.999 confidence with one stray "n/a" in 1,000, flagged mixed', () => {
    const values = [...Array.from({ length: 999 }, (_, index) => String(index)), 'n/a'];
    expect(resolve(values)).toMatchObject({ inferredType: 'integer', typeConfidence: 0.999, isMixedType: true });
  });

  it('falls back to string below the 99% threshold, reporting the plain-text share', () => {
    const values = [...Array.from({ length: 60 }, (_, index) => String(index)), ...Array.from({ length: 40 }, () => 'x')];
    expect(resolve(values)).toMatchObject({ inferredType: 'string', typeConfidence: 0.4, isMixedType: true });
  });

  it('infers decimal when integers and decimals mix', () => {
    expect(resolve(['1', '2.5', '3'])).toMatchObject({ inferredType: 'decimal', typeConfidence: 1 });
  });

  it('infers boolean for true/false text', () => {
    expect(resolve(['true', 'false', 'TRUE']).inferredType).toBe('boolean');
  });

  it('infers date and datetime', () => {
    expect(resolve(['2026-09-14', '2026-09-15']).inferredType).toBe('date');
    expect(resolve(['2026-09-14T10:00:00Z', '2026-09-15T11:00:00Z']).inferredType).toBe('datetime');
  });

  it('marks a column ambiguous and records both formats when every day is 12 or less', () => {
    const resolved = resolve(['01/02/2026', '03/04/2026', '12/11/2025']);
    expect(resolved.inferredType).toBe('date');
    expect(resolved.temporal).toMatchObject({ detectedFormat: 'DD/MM/YYYY', ambiguous: true, alternateFormat: 'MM/DD/YYYY' });
  });

  it('resolves to DD/MM/YYYY unambiguously once one value has day 23', () => {
    const resolved = resolve(['01/02/2026', '03/04/2026', '23/04/2026']);
    expect(resolved.temporal).toMatchObject({ detectedFormat: 'DD/MM/YYYY', ambiguous: false, alternateFormat: null });
    expect(resolved.temporal).toMatchObject({ min: '2026-02-01', max: '2026-04-23' });
  });

  it('falls back to string rather than picking one when two formats mix', () => {
    const resolved = resolve(['2026-01-02', '2026-01-03', '23/04/2026', '24/04/2026']);
    expect(resolved.inferredType).toBe('string');
    expect(resolved.temporal).toBeNull();
  });

  it('reads native workbook dates as dates, or datetimes when any has a time', () => {
    const midnight = (day: number) => new Date(Date.UTC(2026, 0, day));
    expect(resolve([midnight(1), midnight(9)]).temporal).toMatchObject({ detectedFormat: 'excel-native', min: '2026-01-01', max: '2026-01-09' });
    expect(resolve([midnight(1), new Date(Date.UTC(2026, 0, 2, 13, 30))]).inferredType).toBe('datetime');
  });

  it('reports empty with full confidence when nothing is populated', () => {
    expect(resolve([null, '', '  '])).toMatchObject({ inferredType: 'empty', typeConfidence: 1, isMixedType: false });
  });
});

describe('cell helpers', () => {
  it('reports declared source types', () => {
    expect([cellSourceType('x'), cellSourceType(1), cellSourceType(false), cellSourceType(new Date()), cellSourceType(null)]).toEqual([
      'string',
      'number',
      'boolean',
      'date',
      'null',
    ]);
  });

  it('renders cells as sample text', () => {
    expect(cellText(null)).toBe('');
    expect(cellText(true)).toBe('true');
    expect(cellText(3.5)).toBe('3.5');
    expect(cellText(new Date(Date.UTC(2026, 8, 14)))).toBe('2026-09-14');
    expect(cellText(new Date(Date.UTC(2026, 8, 14, 10, 30)))).toBe('2026-09-14T10:30:00Z');
  });

  it('parses numbers only in the accepted shapes', () => {
    expect(parseNumber('-3.5')).toEqual({ value: -3.5, integer: false });
    expect(parseNumber('10')).toEqual({ value: 10, integer: true });
    expect(parseNumber('1,000')).toBeNull();
    expect(parseNumber('Infinity')).toBeNull();
  });
});
