import { describe, expect, it } from 'vitest';
import { findSheetHeader, isBlankRow, isHeaderRow, resolveColumnNames } from '../../ingestion/header-detection';

describe('isHeaderRow', () => {
  it('accepts distinct text over a typed column', () => {
    expect(isHeaderRow(['id', 'name'], [['1', 'Ada'], ['2', 'Grace']])).toEqual({ isHeader: true, confidence: 1 });
  });

  it('rejects a row with an empty cell', () => {
    expect(isHeaderRow(['id', ''], [['1', 'Ada']]).isHeader).toBe(false);
  });

  it('rejects a text-only table with low confidence, because nothing distinguishes row 0', () => {
    expect(isHeaderRow(['first', 'last'], [['Ada', 'Lovelace']])).toEqual({ isHeader: false, confidence: 0.5 });
  });

  it('rejects typed cells in row 0 with full confidence', () => {
    expect(isHeaderRow([1, 'x'], [[2, 'y']])).toEqual({ isHeader: false, confidence: 1 });
    expect(isHeaderRow(['2026-01-02', 'x'], [['2026-01-03', 'y']]).isHeader).toBe(false);
  });

  it('rejects an empty candidate', () => {
    expect(isHeaderRow([], []).isHeader).toBe(false);
  });
});

describe('findSheetHeader', () => {
  it('skips a report title and the blank row under it', () => {
    const rows = [['Q3 Sales Report'], [], ['region', 'amount', 'date'], ['North', 12.5, new Date(Date.UTC(2026, 0, 2))], ['South', 3, new Date(Date.UTC(2026, 0, 3))]];
    expect(findSheetHeader(rows)).toEqual({ headerRowIndex: 2, leadingRowsSkipped: 2, columnOffset: 0 });
  });

  it('finds a header that starts in a later column', () => {
    const rows = [[null, null], [null, 'id', 'amount'], [null, 1, 2]];
    expect(findSheetHeader(rows)).toEqual({ headerRowIndex: 1, leadingRowsSkipped: 1, columnOffset: 1 });
  });

  it('reports no header for a numeric sheet, skipping only leading blank rows', () => {
    const rows = [[], [null], [1, 2], [3, 4]];
    expect(findSheetHeader(rows)).toEqual({ headerRowIndex: null, leadingRowsSkipped: 2, columnOffset: 0 });
  });

  it('does not treat a row as a header when the row after it is also text', () => {
    expect(findSheetHeader([['a', 'b'], ['c', 'd']]).headerRowIndex).toBeNull();
  });

  it('uses rows after the scan limit only to see what follows the last candidate', () => {
    const rows = [...Array.from({ length: 9 }, () => []), ['id', 'x'], [1, 2]];
    expect(findSheetHeader(rows).headerRowIndex).toBe(9);
  });

  it('looks no further than the scan limit for candidates', () => {
    const rows = [...Array.from({ length: 10 }, () => []), ['id', 'x'], [1, 2]];
    expect(findSheetHeader(rows).headerRowIndex).toBeNull();
    expect(findSheetHeader(rows, 12).headerRowIndex).toBe(10);
  });

  it('handles an empty sheet', () => {
    expect(findSheetHeader([])).toEqual({ headerRowIndex: null, leadingRowsSkipped: 0, columnOffset: 0 });
  });
});

describe('resolveColumnNames', () => {
  it('renames duplicates and preserves the original header text', () => {
    const { names, renamed } = resolveColumnNames(['amount', 'amount', 'amount'], 3);
    expect(names).toEqual([
      { name: 'amount', originalName: null },
      { name: 'amount_2', originalName: 'amount' },
      { name: 'amount_3', originalName: 'amount' },
    ]);
    expect(renamed).toEqual(['amount_2', 'amount_3']);
  });

  it('synthesizes names for missing header cells and header-less tables', () => {
    expect(resolveColumnNames(null, 3).names.map(({ name }) => name)).toEqual(['column_1', 'column_2', 'column_3']);
    expect(resolveColumnNames(['id', '  '], 3).names.map(({ name }) => name)).toEqual(['id', 'column_2', 'column_3']);
  });

  it('avoids colliding with a real header that looks synthesized', () => {
    const { names } = resolveColumnNames(['column_2', ''], 2);
    expect(names.map(({ name }) => name)).toEqual(['column_2', 'column_2_2']);
    expect(names[1]!.originalName).toBeNull();
  });

  it('trims header text', () => {
    expect(resolveColumnNames(['  id '], 1).names[0]!.name).toBe('id');
  });
});

describe('isBlankRow', () => {
  it('treats nulls, empty strings, and whitespace as blank', () => {
    expect(isBlankRow([])).toBe(true);
    expect(isBlankRow([null, '', '   '])).toBe(true);
    expect(isBlankRow([null, 0])).toBe(false);
  });
});
