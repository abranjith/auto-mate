// ---------------------------------------------------------------------------
// The bounded formula-prefix scan (FEAT-109 TASK-003).
//
// A generated CSV or workbook can re-emit the person's own cells, and a cell
// starting with `=`, `+`, `-`, `@`, tab, or CR is one Excel may treat as a
// formula. FEAT-104 named this "FEAT-109's harder version of the problem".
// The answer here is INFORMATION, not protection: count such cells in the
// first `formulaScanRows` rows and tell the person. The file is never
// modified — those are the person's bytes.
//
// COUNTS ONLY. No cell value is returned, stored, or logged: this is the
// person's own data and FEAT-104's logging rule covers it. The readers are
// FEAT-104's streaming ones, with their configuration, reused rather than
// re-implemented.
// ---------------------------------------------------------------------------

import { hasFormulaPrefix, type CellValue, type ContentScan } from '@automate/core';
import { openCsv } from '../ingestion/csv-reader';
import { openWorkbook } from '../ingestion/xlsx-reader';

export interface ScanLimits {
  /** Data rows to scan before reporting the scan as capped. */
  readonly formulaScanRows: number;
  /** How far a workbook may expand when unzipped (FEAT-104's budget). */
  readonly maxInflatedBytes: number;
}

/** Running tallies for one table. */
class Tally {
  scannedRows = 0;
  rowsAreCapped = false;
  formulaCellCount = 0;
  sampledColumns = 0;

  /** Count one row's formula-prefixed text cells. */
  add(cells: readonly CellValue[] | readonly string[]): void {
    this.sampledColumns = Math.max(this.sampledColumns, cells.length);
    for (const cell of cells) if (typeof cell === 'string' && hasFormulaPrefix(cell)) this.formulaCellCount += 1;
  }

  result(): ContentScan {
    return { scannedRows: this.scannedRows, rowsAreCapped: this.rowsAreCapped, formulaCellCount: this.formulaCellCount, sampledColumns: this.sampledColumns };
  }
}

/** Count rows up to the limit; one row past it marks the scan capped. */
async function scanRows(rows: AsyncIterable<readonly CellValue[] | readonly string[]>, tally: Tally, limit: number): Promise<void> {
  for await (const row of rows) {
    if (tally.scannedRows >= limit) { tally.rowsAreCapped = true; return; }
    tally.scannedRows += 1;
    tally.add(row);
  }
}

async function scanCsv(filePath: string, limits: ScanLimits, signal: AbortSignal): Promise<ContentScan> {
  const tally = new Tally();
  // One row beyond the cap is requested so "exactly at the cap" and "past it" differ.
  const table = await openCsv(filePath, { maxRows: limits.formulaScanRows + 1, signal });
  try {
    if (table.header) tally.add(table.header);
    await scanRows(table.rows, tally, limits.formulaScanRows);
  } finally {
    table.close();
  }
  return tally.result();
}

async function scanXlsx(filePath: string, limits: ScanLimits, signal: AbortSignal): Promise<ContentScan> {
  const tally = new Tally();
  const workbook = openWorkbook(filePath, { maxSheets: 1, maxInflatedBytes: limits.maxInflatedBytes, signal });
  try {
    for await (const sheet of workbook.sheets) {
      if (sheet.header) tally.add(sheet.header);
      await scanRows(sheet.rows, tally, limits.formulaScanRows);
      break;
    }
  } finally {
    workbook.close();
  }
  return tally.result();
}

/**
 * Scan a tabular artifact for formula-prefixed cells.
 *
 * @param filePath Absolute path of a file inside the data root.
 * @param type `csv` or `xlsx`.
 * @param limits The row cap and the workbook inflation budget.
 * @param signal Cancels the read.
 * @returns Counts only; never a cell value.
 * @throws Whatever FEAT-104's readers throw for an unreadable file; the caller records no scan and moves on.
 */
export function scanTabularArtifact(filePath: string, type: 'csv' | 'xlsx', limits: ScanLimits, signal: AbortSignal): Promise<ContentScan> {
  return type === 'csv' ? scanCsv(filePath, limits, signal) : scanXlsx(filePath, limits, signal);
}
