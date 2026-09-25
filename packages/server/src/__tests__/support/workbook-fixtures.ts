// Test fixture generation for workbooks. Not a test file.
//
// Most fixtures come from exceljs's STREAMING writer, which writes ZIP data
// descriptors and puts `xl/workbook.xml` last — the layout that exposed the
// unzipper premature-`end` bug the reader guards against, so every fixture
// doubles as a regression test for it. `writeBufferedWorkbook` uses the
// in-memory writer, whose local headers carry sizes (the layout Excel itself
// writes); it is fixture generation only and never reads a workbook.
import ExcelJS from 'exceljs';

/** A cell a fixture can hold: primitives, dates, and formulas with a cached result. */
export type FixtureCell = string | number | boolean | Date | null | { formula: string; result: unknown };

export interface FixtureSheet {
  readonly name: string;
  readonly state?: 'visible' | 'hidden' | 'veryHidden';
  readonly rows: readonly (readonly FixtureCell[])[];
  /** Ranges such as `A1:C1`, merged before their rows are committed. */
  readonly merges?: readonly string[];
  /** Number formats by 1-based column, e.g. `{ 3: 'yyyy-mm-dd' }`. */
  readonly formats?: Readonly<Record<number, string>>;
}

type StreamingWorksheet = {
  addRow(values: unknown[]): { commit(): void; getCell(column: number): { numFmt: string } };
  mergeCells(range: string): void;
  commit(): Promise<void>;
};

/** Write a workbook with the streaming writer (data descriptors, workbook part last). */
export async function writeStreamingWorkbook(filename: string, sheets: readonly FixtureSheet[], useSharedStrings = true): Promise<void> {
  const writer = new ExcelJS.stream.xlsx.WorkbookWriter({ filename, useSharedStrings, useStyles: true });
  for (const spec of sheets) {
    const sheet = writer.addWorksheet(spec.name, { state: spec.state ?? 'visible' }) as unknown as StreamingWorksheet;
    const added = spec.rows.map((cells) => {
      const row = sheet.addRow([...cells]);
      for (const [column, format] of Object.entries(spec.formats ?? {})) row.getCell(Number(column)).numFmt = format;
      return row;
    });
    for (const range of spec.merges ?? []) sheet.mergeCells(range);
    added.forEach((row) => row.commit());
    await sheet.commit();
  }
  await writer.commit();
}

/** Write a large single-sheet workbook row by row without holding it in memory. */
export async function writeLargeWorkbook(filename: string, rows: number, useSharedStrings = false): Promise<void> {
  const writer = new ExcelJS.stream.xlsx.WorkbookWriter({ filename, useSharedStrings, useStyles: false });
  const sheet = writer.addWorksheet('Data') as unknown as StreamingWorksheet;
  sheet.addRow(['id', 'region', 'amount', 'units', 'code']).commit();
  const regions = ['North', 'South', 'East', 'West'];
  for (let index = 1; index < rows; index += 1) {
    sheet.addRow([index, regions[index % 4], (index % 997) * 1.25, index % 13, `C-${index % 50}`]).commit();
  }
  await sheet.commit();
  await writer.commit();
}

/** Write a workbook with the in-memory writer: sized local headers, as Excel writes them. Fixture generation only. */
export async function writeBufferedWorkbook(filename: string, sheets: readonly FixtureSheet[]): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  for (const spec of sheets) {
    const sheet = workbook.addWorksheet(spec.name, { state: spec.state ?? 'visible' });
    spec.rows.forEach((cells) => sheet.addRow([...cells]));
    for (const range of spec.merges ?? []) sheet.mergeCells(range);
  }
  await workbook.xlsx.writeFile(filename);
}
