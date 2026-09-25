import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createReadStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { ParseFailedError, WorkbookTooLargeError, cellSourceType, profileTable, type CellValue } from '@automate/core';
import { excelSerialToDate, isDateFormat, openWorkbook, type XlsxReaderOptions, type XlsxSheet } from '../../ingestion/xlsx-reader';
import { writeBufferedWorkbook, writeLargeWorkbook, writeStreamingWorkbook } from '../support/workbook-fixtures';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'automate-xlsx-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const options: XlsxReaderOptions = { maxSheets: 20, maxInflatedBytes: 1024 * 1024 * 1024 };
const jan = (day: number) => new Date(Date.UTC(2026, 0, day));

interface ReadSheet {
  sheet: XlsxSheet;
  rows: CellValue[][];
}

async function readAll(file: string, extra: Partial<XlsxReaderOptions> = {}): Promise<{ sheets: ReadSheet[]; facts: ReturnType<typeof openWorkbook>['facts'] }> {
  const workbook = openWorkbook(file, { ...options, ...extra });
  const sheets: ReadSheet[] = [];
  try {
    for await (const sheet of workbook.sheets) {
      const rows: CellValue[][] = [];
      for await (const row of sheet.rows) rows.push(row);
      sheets.push({ sheet, rows });
    }
  } finally {
    workbook.close();
  }
  return { sheets, facts: workbook.facts };
}

describe('openWorkbook', () => {
  it('reads a single-sheet workbook with the right rows and columns', async () => {
    const file = path.join(dir, 'one.xlsx');
    await writeStreamingWorkbook(file, [{ name: 'Data', rows: [['id', 'name'], [1, 'Ada'], [2, 'Grace']] }]);
    const { sheets } = await readAll(file);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.sheet).toMatchObject({ name: 'Data', index: 0, hidden: false, header: ['id', 'name'], headerRowIndex: 0, expectedWidth: 2 });
    expect(sheets[0]!.rows).toEqual([
      [1, 'Ada'],
      [2, 'Grace'],
    ]);
  });

  it('reads the Excel-style layout with sized entries as well', async () => {
    const file = path.join(dir, 'sized.xlsx');
    await writeBufferedWorkbook(file, [{ name: 'Data', rows: [['id', 'name'], [1, 'Ada']] }]);
    const { sheets } = await readAll(file);
    expect(sheets[0]!.rows).toEqual([[1, 'Ada']]);
  });

  it('yields four sheets in workbook order, flags the hidden one, and keeps an empty one from failing the rest', async () => {
    const file = path.join(dir, 'four.xlsx');
    await writeStreamingWorkbook(file, [
      { name: 'North', rows: [['id', 'v'], [1, 2]] },
      { name: 'South', rows: [['id', 'v'], [3, 4]] },
      { name: 'Secret', state: 'hidden', rows: [['id', 'v'], [5, 6]] },
      { name: 'Blank', rows: [] },
    ]);
    const { sheets, facts } = await readAll(file);
    expect(sheets.map(({ sheet }) => [sheet.name, sheet.index, sheet.hidden])).toEqual([
      ['North', 0, false],
      ['South', 1, false],
      ['Secret', 2, true],
      ['Blank', 3, false],
    ]);
    expect(sheets[3]!.rows).toEqual([]);
    expect(sheets[3]!.sheet.header).toBeNull();
    expect(facts).toMatchObject({ totalSheets: 4, sheetsRead: 4, notes: [] });
  });

  it('delivers typed number, date, and boolean cells as native values', async () => {
    const file = path.join(dir, 'typed.xlsx');
    await writeStreamingWorkbook(file, [{ name: 'T', rows: [['n', 'd', 'b', 's'], [12.5, jan(2), true, 'x']], formats: { 2: 'yyyy-mm-dd' } }]);
    const row = (await readAll(file)).sheets[0]!.rows[0]!;
    expect(row.map(cellSourceType)).toEqual(['number', 'date', 'boolean', 'string']);
    expect(row[1]).toEqual(jan(2));
  });

  it('uses a formula\'s cached result, never its text, and counts it', async () => {
    const file = path.join(dir, 'formula.xlsx');
    await writeStreamingWorkbook(file, [
      {
        name: 'F',
        rows: [
          ['a', 'double', 'when'],
          [2, { formula: 'A2*2', result: 4 }, { formula: 'DATE(2026,1,3)', result: 46025 }],
        ],
        formats: { 3: 'yyyy-mm-dd' },
      },
    ]);
    const { sheets } = await readAll(file);
    expect(sheets[0]!.rows[0]).toEqual([2, 4, excelSerialToDate(46025, false)]);
    expect(JSON.stringify(sheets[0]!.rows)).not.toContain('A2*2');
    expect(sheets[0]!.sheet.describe()).toMatchObject({ formulaCellCount: 2 });
  });

  it('counts merged cells and finds the real header under a merged report title', async () => {
    const file = path.join(dir, 'report.xlsx');
    await writeStreamingWorkbook(file, [
      {
        name: 'Report',
        rows: [['Q3 Sales Report'], [], ['region', 'amount'], ['North', 12.5], ['South', 3]],
        merges: ['A1:B1'],
      },
    ]);
    const { sheets } = await readAll(file);
    const { sheet, rows } = sheets[0]!;
    expect(sheet).toMatchObject({ header: ['region', 'amount'], headerRowIndex: 2, leadingRowsSkipped: 2 });
    expect(rows).toEqual([
      ['North', 12.5],
      ['South', 3],
    ]);
    expect(sheet.describe().mergedCellCount).toBe(1);
  });

  it('handles a sheet with no header, re-based to where the data starts', async () => {
    const file = path.join(dir, 'noheader.xlsx');
    await writeStreamingWorkbook(file, [{ name: 'N', rows: [[], [null, 1, 2], [null, 3, 4]] }]);
    const { sheet, rows } = (await readAll(file)).sheets[0]!;
    expect(sheet).toMatchObject({ header: null, headerRowIndex: null, leadingRowsSkipped: 1, expectedWidth: 2 });
    expect(rows).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('reads the first maxSheets sheets and notes the cap', async () => {
    const file = path.join(dir, 'many.xlsx');
    await writeStreamingWorkbook(file, Array.from({ length: 5 }, (_, index) => ({ name: `S${index}`, rows: [['a', 'b'], [index, index]] })));
    const { sheets, facts } = await readAll(file, { maxSheets: 3 });
    expect(sheets.map(({ sheet }) => sheet.name)).toEqual(['S0', 'S1', 'S2']);
    expect(facts.notes).toEqual([{ code: 'sheet_cap_reached', limit: 3, count: 5 }]);
  });

  it('raises WorkbookTooLargeError before parsing completes when the workbook inflates past its budget', async () => {
    const file = path.join(dir, 'bomb.xlsx');
    await writeLargeWorkbook(file, 60_000);
    const budget = 512 * 1024;
    const workbook = openWorkbook(file, { ...options, maxInflatedBytes: budget });
    let rowsSeen = 0;
    const read = async () => {
      for await (const sheet of workbook.sheets) for await (const row of sheet.rows) rowsSeen += row.length > 0 ? 1 : 0;
    };
    await expect(read()).rejects.toBeInstanceOf(WorkbookTooLargeError);
    workbook.close();
    expect(rowsSeen).toBeLessThan(60_000 / 4);
    expect(workbook.facts.inflatedBytes).toBeLessThan(budget + 256 * 1024);
  });

  it('holds the shared-string table to a quarter of the budget', async () => {
    const file = path.join(dir, 'strings.xlsx');
    const rows = [['text'], ...Array.from({ length: 20_000 }, (_, index) => [`unique text value number ${index} ${'x'.repeat(20)}`])];
    await writeStreamingWorkbook(file, [{ name: 'S', rows }]);
    const failure = await readAll(file, { maxInflatedBytes: 3 * 1024 * 1024 }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(WorkbookTooLargeError);
    expect((failure as Error).message).toContain('shared text table');
  });

  it('raises a plain-English ParseFailedError for a corrupt or truncated workbook, without hanging', async () => {
    const corrupt = path.join(dir, 'corrupt.xlsx');
    writeFileSync(corrupt, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(4096, 0x5a)]));
    const good = path.join(dir, 'good.xlsx');
    await writeStreamingWorkbook(good, [{ name: 'D', rows: [['a'], [1]] }]);
    const truncated = path.join(dir, 'truncated.xlsx');
    const bytes = readFileSync(good);
    writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length / 2)));
    for (const file of [corrupt, truncated]) {
      const failure = await readAll(file).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ParseFailedError);
      expect((failure as Error).message).toMatch(/damaged or is not a real Excel workbook/);
      expect((failure as Error).message).not.toMatch(/signature|unzip|FILE_ENDED|Cannot read/i);
    }
  });

  it('stops and destroys the stream when the signal aborts', async () => {
    const file = path.join(dir, 'abort.xlsx');
    await writeLargeWorkbook(file, 50_000);
    const streams: Readable[] = [];
    const controller = new AbortController();
    const workbook = openWorkbook(file, {
      ...options,
      signal: controller.signal,
      openStream: (target) => {
        const stream = createReadStream(target);
        streams.push(stream);
        return stream;
      },
    });
    const read = async () => {
      let seen = 0;
      for await (const sheet of workbook.sheets) {
        for await (const row of sheet.rows) {
          expect(row).toHaveLength(5);
          if (++seen === 100) controller.abort(new Error('timed out'));
        }
      }
    };
    await expect(read()).rejects.toThrow('timed out');
    workbook.close();
    expect(streams[0]!.destroyed).toBe(true);
  });
});

describe('date helpers', () => {
  it('converts serials in both date systems and recognises date formats', () => {
    expect(excelSerialToDate(46025, false)).toEqual(jan(3));
    expect(excelSerialToDate(46025 - 1462, true)).toEqual(jan(3));
    expect(isDateFormat('yyyy-mm-dd')).toBe(true);
    expect(isDateFormat('[h]:mm')).toBe(true);
    expect(isDateFormat('#,##0.00')).toBe(false);
    expect(isDateFormat('"Day" 0')).toBe(false);
    expect(isDateFormat(undefined)).toBe(false);
  });
});

describe('streaming memory', () => {
  let bigDir: string;
  let big: string;
  beforeAll(async () => {
    bigDir = mkdtempSync(path.join(tmpdir(), 'automate-xlsx-big-'));
    big = path.join(bigDir, 'big.xlsx');
    await writeLargeWorkbook(big, 300_001, true);
  }, 180_000);
  afterAll(() => rmSync(bigDir, { recursive: true, force: true }));

  it('profiles a 300,001-row workbook with flat memory (guards the streaming decision)', async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    gc();
    const baseline = process.memoryUsage().heapUsed;
    let peak = baseline;
    const workbook = openWorkbook(big, options);
    try {
      for await (const sheet of workbook.sheets) {
        const tracked = (async function* () {
          let seen = 0;
          for await (const row of sheet.rows) {
            if (++seen % 20_000 === 0) peak = Math.max(peak, process.memoryUsage().heapUsed);
            yield row;
          }
        })();
        const profile = await profileTable(
          { rows: tracked, header: sheet.header, headerRowIndex: sheet.headerRowIndex, expectedWidth: sheet.expectedWidth, raggedMode: 'overflow' },
          { sheetName: sheet.name, sheetIndex: sheet.index, isHidden: sheet.hidden, delimiter: null, dialect: null },
          { seed: 'e'.repeat(64), maxRows: 1_000_000, maxColumns: 512 },
        );
        expect(profile.rowCount).toBe(300_000);
        expect(profile.columns.map(({ inferredType }) => inferredType)).toEqual(['integer', 'string', 'decimal', 'integer', 'string']);
      }
    } finally {
      workbook.close();
    }
    expect(peak - baseline).toBeLessThan(200 * 1024 * 1024);
  }, 120_000);
});
