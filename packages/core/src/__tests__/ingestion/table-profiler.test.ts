import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { TableProfileSchema } from '../../contracts/upload-api';
import { NoTabularContentError, TooManyColumnsError } from '../../errors/ingestion-errors';
import { profileTable, truncateCell, type TableMeta, type TableSource } from '../../ingestion/table-profiler';
import type { CellValue } from '../../ingestion/type-inference';

const meta: TableMeta = { sheetName: null, sheetIndex: 0, isHidden: false, delimiter: ',', dialect: null };
const options = { seed: 'f'.repeat(64), maxRows: 1_000_000, maxColumns: 512 };

function source(rows: readonly (readonly CellValue[])[], header: readonly CellValue[] | null = ['id', 'amount'], extra: Partial<TableSource> = {}): TableSource {
  return { rows, header, headerRowIndex: header === null ? null : 0, ...extra };
}

async function* asAsync(rows: readonly (readonly CellValue[])[]) {
  for (const row of rows) yield row;
}

const numbered = (count: number) => Array.from({ length: count }, (_, index) => [String(index + 1), String((index + 1) * 2)]);

describe('profileTable', () => {
  it('produces a schema-valid profile from an async iterator', async () => {
    const profile = await profileTable(source(asAsync(numbered(3)) as never), meta, options);
    expect(Value.Errors(TableProfileSchema, profile).First()).toBeUndefined();
    expect(profile).toMatchObject({ rowCount: 3, rowCountExact: true, columnCount: 2, hasHeader: true, headerRowIndex: 0 });
    expect(profile.columns.map(({ name, inferredType }) => [name, inferredType])).toEqual([
      ['id', 'integer'],
      ['amount', 'integer'],
    ]);
  });

  it('keeps ten sample rows, truncating long cells to 200 characters with a marker but keeping the row', async () => {
    const rows = numbered(25);
    rows[1] = ['2', 'x'.repeat(300)];
    const profile = await profileTable(source(rows), meta, options);
    expect(profile.sampleRows).toHaveLength(10);
    expect(profile.sampleRows[1]![1]).toHaveLength(200);
    expect(profile.sampleRows[1]![1]!.endsWith('…')).toBe(true);
    expect(profile.rowCount).toBe(25);
  });

  it('counts ragged rows without corrupting column alignment', async () => {
    const rows = [['1', '10'], ['2'], ['3', '30', 'extra'], ['4', '40']];
    const profile = await profileTable(source(rows), meta, options);
    expect(profile.raggedRowCount).toBe(2);
    expect(profile.columns[1]).toMatchObject({ nullCount: 1, valueCount: 3 });
    expect(profile.sampleRows[2]).toEqual(['3', '30']);
    expect(profile.notes).toContainEqual({ code: 'ragged_rows', count: 2 });
  });

  it('counts overflow, not short rows, as ragged for grid sources', async () => {
    const rows = [[1, 10], [2], [3, 30, 'note']];
    const profile = await profileTable(source(rows, ['id', 'amount'], { raggedMode: 'overflow' }), meta, options);
    expect(profile.raggedRowCount).toBe(1);
  });

  it('counts blank rows and excludes them from the row count and sample', async () => {
    const rows = [['1', '2'], [''], [null, '  '], ['3', '4'], [''], ['']];
    const profile = await profileTable(source(rows), meta, options);
    expect(profile.rowCount).toBe(2);
    expect(profile.blankRowCount).toBe(4);
    expect(profile.sampleRows).toEqual([['1', '2'], ['3', '4']]);
    expect(profile.notes).toContainEqual({ code: 'blank_rows', count: 4 });
  });

  it('stops at maxRows, reports the count as inexact, and emits row_cap_reached', async () => {
    const profile = await profileTable(source(numbered(20)), meta, { ...options, maxRows: 10 });
    expect(profile).toMatchObject({ rowCount: 10, rowCountExact: false });
    expect(profile.notes).toContainEqual({ code: 'row_cap_reached', limit: 10 });
  });

  it('keeps an exact count when a table has exactly maxRows rows', async () => {
    const profile = await profileTable(source(numbered(10)), meta, { ...options, maxRows: 10 });
    expect(profile).toMatchObject({ rowCount: 10, rowCountExact: true });
  });

  it('reports inexact when the reader itself was truncated', async () => {
    const profile = await profileTable(source(numbered(2), ['id', 'amount'], { describe: () => ({ truncated: true }) }), meta, options);
    expect(profile.rowCountExact).toBe(false);
  });

  it('stops the underlying iterator when the cap is hit', async () => {
    let returned = false;
    const rows = {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          next: async () => ({ done: false, value: [String(index++), '1'] }),
          return: async () => {
            returned = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    await profileTable(source(rows as never), meta, { ...options, maxRows: 5 });
    expect(returned).toBe(true);
  });

  it('raises TooManyColumnsError when the header exceeds maxColumns', async () => {
    const header = Array.from({ length: 6 }, (_, index) => `c${index}`);
    await expect(profileTable(source([], header), meta, { ...options, maxColumns: 5 })).rejects.toBeInstanceOf(TooManyColumnsError);
  });

  it('raises TooManyColumnsError for a header-less table whose first row is too wide', async () => {
    await expect(profileTable(source([Array(6).fill('1')], null), meta, { ...options, maxColumns: 5 })).rejects.toThrow(/6 columns/);
  });

  it('renames duplicate headers, preserves the original name, and notes it', async () => {
    const profile = await profileTable(source([['1', '2', '3']], ['amount', 'amount', 'city']), meta, options);
    expect(profile.columns[1]).toMatchObject({ name: 'amount_2', originalName: 'amount' });
    expect(profile.notes).toContainEqual({ code: 'duplicate_headers_renamed', count: 1, columns: ['amount_2'] });
  });

  it('raises NoTabularContentError for an empty iterator with no header', async () => {
    await expect(profileTable(source([], null), meta, options)).rejects.toBeInstanceOf(NoTabularContentError);
    await expect(profileTable(source([[''], [null]], null, { expectedWidth: 1 }), meta, options)).rejects.toBeInstanceOf(NoTabularContentError);
  });

  it('describes a header-only table with zero rows', async () => {
    const profile = await profileTable(source([]), meta, options);
    expect(profile).toMatchObject({ rowCount: 0, columnCount: 2, sampleRows: [] });
    expect(profile.columns.map(({ inferredType }) => inferredType)).toEqual(['empty', 'empty']);
  });

  it('synthesizes names and notes a missing header', async () => {
    const profile = await profileTable(source([['1', 'x']], null), meta, options);
    expect(profile.columns.map(({ name }) => name)).toEqual(['column_1', 'column_2']);
    expect(profile.notes).toContainEqual({ code: 'no_header_detected' });
    expect(profile.headerRowIndex).toBeNull();
  });

  it('widens to the expected width and names the extra columns', async () => {
    const profile = await profileTable(source([['1', '2', '3']], ['id'], { expectedWidth: 3 }), meta, options);
    expect(profile.columns.map(({ name }) => name)).toEqual(['id', 'column_2', 'column_3']);
  });

  it('notes ambiguous dates and mixed columns per column', async () => {
    const rows = [['01/02/2026', '1'], ['03/04/2026', 'n/a'], ['05/06/2026', ...['3']]];
    const profile = await profileTable(source(rows, ['when', 'qty']), meta, options);
    expect(profile.notes).toContainEqual({ code: 'ambiguous_date_format', column: 'when', formats: ['DD/MM/YYYY', 'MM/DD/YYYY'] });
    // Two of three values are numbers, below the 99% bar: text, with two values that are not plain text.
    expect(profile.notes).toContainEqual({ code: 'mixed_type_column', column: 'qty', count: 2 });
    const mixed = await profileTable(source([...numbered(199), ['n/a', '1']], ['id', 'amount']), meta, options);
    expect(mixed.notes).toContainEqual({ code: 'mixed_type_column', column: 'id', count: 1 });
  });

  it('passes through reader facts and notes the hidden sheet, merges, and formulas', async () => {
    const profile = await profileTable(
      source([[1, 2]], ['a', 'b'], { leadingRowsSkipped: 2, describe: () => ({ mergedCellCount: 3, formulaCellCount: 4, notes: [{ code: 'encoding_guessed', formats: ['windows-1252'] }] }) }),
      { ...meta, sheetName: 'Q3', sheetIndex: 2, isHidden: true, delimiter: null },
      options,
    );
    expect(profile).toMatchObject({ sheetName: 'Q3', sheetIndex: 2, isHidden: true, mergedCellCount: 3, formulaCellCount: 4 });
    expect(profile.notes.map(({ code }) => code)).toEqual(['leading_blank_rows_skipped', 'hidden_sheet', 'merged_cells', 'formula_cells', 'encoding_guessed']);
  });

  it('is deterministic for the same rows and seed', async () => {
    const rows = Array.from({ length: 3_000 }, (_, index) => [String(index), String((index * 31) % 97)]);
    const first = JSON.stringify(await profileTable(source(rows), meta, options));
    expect(JSON.stringify(await profileTable(source(rows), meta, options))).toBe(first);
  });

  it('honours an aborted signal', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(profileTable(source(numbered(5)), meta, { ...options, signal: controller.signal })).rejects.toThrow('stop');
  });
});

describe('truncateCell', () => {
  it('leaves short cells alone and never splits a surrogate pair', () => {
    expect(truncateCell('abc')).toBe('abc');
    expect(truncateCell('x'.repeat(200))).toHaveLength(200);
    const emoji = `${'x'.repeat(198)}😀😀`;
    const cut = truncateCell(emoji);
    expect(cut.length).toBeLessThanOrEqual(200);
    expect(cut).toBe(`${'x'.repeat(198)}…`);
  });
});
