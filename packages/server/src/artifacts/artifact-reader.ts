// ---------------------------------------------------------------------------
// Server-side previews (FEAT-109 TASK-005).
//
// A 400 MB CSV must not become a 400 MB fetch: tables are paged here, through
// FEAT-104's streaming `csv-parse` and `exceljs` `WorkbookReader` — the same
// readers and configuration, no second parser — and only one page crosses the
// wire. Every cell is returned VERBATIM as text (never rewritten, formula
// prefixes included), capped at 200 characters per cell, FEAT-104's
// disclosure bound, which is the right bound for a DOM too. A request never
// streams past `maxTableScanRows`; reaching it is reported as a cap rather
// than presented as a total — FEAT-104's `row_count_exact` lesson.
//
// Text, JSON, and Markdown return their head, up to the preview cap, decoded
// as UTF-8 with replacement rather than throwing. Markdown past the cap is
// refused instead: a cut document rendered as formatted text can read as a
// complete one.
//
// Nothing read here is logged.
// ---------------------------------------------------------------------------

import { open } from 'node:fs/promises';
import { truncateCell, type CellValue, type TablePage } from '@automate/core';
import { openCsv } from '../ingestion/csv-reader';
import { openWorkbook } from '../ingestion/xlsx-reader';

export interface TableReadLimits {
  /** Rows one request may stream through before reporting the cap. */
  readonly maxTableScanRows: number;
  /** FEAT-104's workbook inflation budget. */
  readonly maxInflatedBytes: number;
}

/** U+FEFF, dropped from the start of a text preview. */
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/** A page before the route adds the stored formula count. */
export type TablePageBody = Omit<TablePage, 'formulaCellCount'>;

/** Collects one page from a row stream. */
class PageCollector {
  readonly rows: string[][] = [];
  truncatedCellCount = 0;
  hasMore = false;
  scanned = 0;

  constructor(private readonly offset: number, private readonly limit: number) {}

  /** Offer the next row. @returns false once the page is full and one more row has been seen. */
  offer(row: readonly CellValue[] | readonly string[]): boolean {
    const index = this.scanned;
    this.scanned += 1;
    if (index < this.offset) return true;
    if (this.rows.length >= this.limit) { this.hasMore = true; return false; }
    this.rows.push(row.map((cell) => this.cell(cell)));
    return true;
  }

  cell(value: CellValue | string): string {
    const text = cellText(value);
    const cut = truncateCell(text);
    if (cut !== text) this.truncatedCellCount += 1;
    return cut;
  }
}

/** A cell as text: exactly what the file holds, never evaluated. */
function cellText(value: CellValue | string): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().replace('T00:00:00.000Z', '');
  return String(value);
}

function columnsOf(header: readonly (CellValue | string)[] | null, width: number): string[] {
  if (header) return header.map((cell, index) => cellText(cell) || `Column ${index + 1}`);
  return Array.from({ length: width }, (_, index) => `Column ${index + 1}`);
}

/** Drain a row stream into a page, stopping at the page end or the scan cap. */
async function collect(rows: AsyncIterable<readonly CellValue[] | readonly string[]>, page: PageCollector, cap: number): Promise<boolean> {
  for await (const row of rows) {
    if (page.scanned >= cap) return true;
    if (!page.offer(row)) return false;
  }
  return false;
}

async function readCsvPage(filePath: string, offset: number, limit: number, limits: TableReadLimits, signal: AbortSignal): Promise<TablePageBody> {
  const page = new PageCollector(offset, limit);
  const table = await openCsv(filePath, { maxRows: limits.maxTableScanRows + 1, signal });
  let capped: boolean;
  try { capped = await collect(table.rows, page, limits.maxTableScanRows); } finally { table.close(); }
  const width = Math.max(table.header?.length ?? 0, ...page.rows.map((row) => row.length));
  return { columns: columnsOf(table.header, width).map((name) => page.cell(name)), rows: page.rows, offset, limit, hasMore: page.hasMore && !capped, scannedRowsCapped: capped, truncatedCellCount: page.truncatedCellCount, sheet: null, otherSheets: [] };
}

/** Sheets named after the first, walked only when the first page is asked for. */
const MAX_LISTED_SHEETS = 20;

/**
 * The other sheets' names. Excel writes the workbook part first, so the names
 * are usually known already; a writer that puts it last (openpyxl, exceljs's
 * streaming writer) leaves them unknown until the sheets have streamed past,
 * which is walked for the FIRST page only — later pages never pay for it.
 */
async function otherSheetNames(workbook: ReturnType<typeof openWorkbook>, sheets: AsyncIterator<{ name: string }>, first: string, offset: number): Promise<string[]> {
  const known = workbook.sheetNames();
  if (known.length > 0 || offset > 0) return known.filter((name) => name !== first);
  const names: string[] = [];
  for (let next = await sheets.next(); !next.done && names.length < MAX_LISTED_SHEETS; next = await sheets.next()) names.push(next.value.name);
  return names;
}

async function readXlsxPage(filePath: string, offset: number, limit: number, limits: TableReadLimits, signal: AbortSignal): Promise<TablePageBody> {
  const page = new PageCollector(offset, limit);
  const workbook = openWorkbook(filePath, { maxSheets: MAX_LISTED_SHEETS + 1, maxInflatedBytes: limits.maxInflatedBytes, signal });
  try {
    const sheets = workbook.sheets[Symbol.asyncIterator]();
    const first = await sheets.next();
    if (first.done) return { columns: [], rows: [], offset, limit, hasMore: false, scannedRowsCapped: false, truncatedCellCount: 0, sheet: null, otherSheets: [] };
    const sheet = first.value;
    const capped = await collect(sheet.rows, page, limits.maxTableScanRows);
    const width = Math.max(sheet.header?.length ?? 0, ...page.rows.map((row) => row.length));
    const otherSheets = await otherSheetNames(workbook, sheets, sheet.name, offset);
    return { columns: columnsOf(sheet.header, width).map((name) => page.cell(name)), rows: page.rows, offset, limit, hasMore: page.hasMore && !capped, scannedRowsCapped: capped, truncatedCellCount: page.truncatedCellCount, sheet: sheet.name, otherSheets };
  } finally {
    workbook.close();
  }
}

/**
 * Read one page of a CSV, or of a workbook's first sheet.
 *
 * @param filePath Absolute path inside the data root.
 * @param type `csv` or `xlsx`.
 * @param offset Data rows to skip.
 * @param limit Rows to return.
 * @param limits The per-request scan cap and the workbook inflation budget.
 * @param signal Cancels the read, for example when the client disconnects.
 * @returns The columns, the rows as verbatim text, and whether more rows follow or the scan was capped.
 * @throws FEAT-104's ParseFailedError or WorkbookTooLargeError for a file that cannot be read as a table.
 */
export function readTablePage(filePath: string, type: 'csv' | 'xlsx', offset: number, limit: number, limits: TableReadLimits, signal: AbortSignal): Promise<TablePageBody> {
  return type === 'csv' ? readCsvPage(filePath, offset, limit, limits, signal) : readXlsxPage(filePath, offset, limit, limits, signal);
}

/**
 * Read the head of a text file.
 *
 * @param filePath Absolute path inside the data root.
 * @param maxBytes At most this many bytes are read.
 * @returns The decoded head (invalid UTF-8 becomes U+FFFD), whether it was cut, and the sizes.
 */
export async function readTextPreview(filePath: string, maxBytes: number): Promise<{ text: string; truncated: boolean; byteSize: number; previewBytes: number }> {
  const handle = await open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    const truncated = size > read;
    // A cut mid-character decodes as one replacement character rather than failing.
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer.subarray(0, read));
    return { text: (text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text), truncated, byteSize: size, previewBytes: read };
  } finally {
    await handle.close();
  }
}
