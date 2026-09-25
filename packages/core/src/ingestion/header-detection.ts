// ---------------------------------------------------------------------------
// Header detection and column naming (FEAT-104 TASK-002).
//
// Module invariant: pure and synchronous, no Node built-ins, no I/O.
//
// Deciding whether a row is a header is cosmetic under D06 — this module
// decides it, and reports a confidence so the decision is visible. Renaming a
// duplicate header is never silent: the original name is kept beside the new
// one.
// ---------------------------------------------------------------------------

import { HEADER_SCAN_ROWS } from './limits';
import { classifyCell, TypeTally, type CellValue } from './type-inference';

/** One resolved column name, with the header text it replaced when deduplication renamed it. */
export interface ColumnName {
  readonly name: string;
  readonly originalName: string | null;
}

/** Whether a row is a header, and how sure the detector is. */
export interface HeaderDecision {
  readonly isHeader: boolean;
  readonly confidence: number;
}

/** A row is blank when every cell is null or whitespace. */
export function isBlankRow(row: readonly CellValue[]): boolean {
  return row.every((cell) => {
    const kind = classifyCell(cell);
    return kind === 'null' || kind === 'blank';
  });
}

function isPlainText(cell: CellValue | undefined): boolean {
  return cell !== undefined && classifyCell(cell) === 'string';
}

/** True when at least one column position has a narrower-than-text type in the given rows. */
function hasTypedColumn(width: number, rows: readonly (readonly CellValue[])[], offset = 0): boolean {
  for (let column = 0; column < width; column += 1) {
    const tally = new TypeTally();
    for (const row of rows) tally.push(row[offset + column] ?? null);
    const type = tally.resolve().inferredType;
    if (type !== 'string' && type !== 'empty') return true;
  }
  return false;
}

/**
 * Decide whether row 0 of a delimited file is a header.
 *
 * Row 0 is a header when every cell is non-empty plain text, no two cells are
 * equal, and at least one column is typed (number, date, boolean) in the rows
 * beneath it. A file with only one row is read as a header when that row
 * would otherwise qualify, so a header-only file keeps its column names.
 *
 * @param candidate The first non-blank row.
 * @param below The non-blank rows after it.
 * @returns The decision and its confidence.
 * @example isHeaderRow(['id', 'name'], [['1', 'Ada']]) // { isHeader: true, confidence: 1 }
 */
export function isHeaderRow(candidate: readonly CellValue[], below: readonly (readonly CellValue[])[]): HeaderDecision {
  if (candidate.length === 0) return { isHeader: false, confidence: 1 };
  if (!candidate.every(isPlainText)) {
    const typed = candidate.some((cell) => ['integer', 'decimal', 'boolean', 'temporal'].includes(classifyCell(cell)));
    return { isHeader: false, confidence: typed ? 1 : 0.5 };
  }
  const labels = candidate.map((cell) => String(cell).trim());
  if (new Set(labels).size !== labels.length) return { isHeader: false, confidence: 0.5 };
  if (below.length === 0) return { isHeader: true, confidence: 0.5 };
  return hasTypedColumn(candidate.length, below) ? { isHeader: true, confidence: 1 } : { isHeader: false, confidence: 0.5 };
}

/** Where a workbook sheet's table starts, found by scanning its first rows. */
export interface SheetHeaderScan {
  /** Index of the header row within the scanned rows, or null when none qualified. */
  readonly headerRowIndex: number | null;
  /** Rows before the header (or before the first data row): titles and blanks. */
  readonly leadingRowsSkipped: number;
  /** The first column of the table; columns before it are empty in the scanned rows. */
  readonly columnOffset: number;
}

function span(row: readonly CellValue[]): [number, number] | null {
  let first = -1;
  let last = -1;
  row.forEach((cell, index) => {
    const kind = classifyCell(cell ?? null);
    if (kind === 'null' || kind === 'blank') return;
    if (first < 0) first = index;
    last = index;
  });
  return first < 0 ? null : [first, last];
}

/**
 * Find a worksheet's header by scanning its first rows.
 *
 * The header is the first row whose populated cells are all plain text, that
 * spans at least two columns and at least half the widest scanned row, and
 * whose next non-blank row has a different type profile (at least one typed
 * cell under it). A one-cell title such as "Q3 Sales Report" in A1 therefore
 * never becomes the header; it and any blank rows are reported as skipped.
 *
 * Only the first `scanLimit` rows are header candidates; rows after them are
 * used solely to see what follows a candidate, so pass a few extra.
 *
 * @param rows The first rows of a sheet, as read.
 * @param scanLimit How many rows may be the header.
 * @returns The header position, rows skipped above the table, and the table's first column.
 * @example findSheetHeader([['Report'], [], ['id', 'x'], [1, 2]]).headerRowIndex // 2
 */
export function findSheetHeader(rows: readonly (readonly CellValue[])[], scanLimit = HEADER_SCAN_ROWS): SheetHeaderScan {
  const scanned = rows.slice(0, scanLimit);
  const spans = rows.map(span);
  const widest = Math.max(0, ...spans.map((extent) => (extent ? extent[1] - extent[0] + 1 : 0)));
  for (let index = 0; index < scanned.length; index += 1) {
    const extent = spans[index];
    if (!extent) continue;
    const width = extent[1] - extent[0] + 1;
    const cells = scanned[index]!.slice(extent[0], extent[1] + 1);
    if (width < 2 || width * 2 < widest || !cells.every(isPlainText)) continue;
    const next = rows.slice(index + 1).find((row) => !isBlankRow(row));
    if (next && hasTypedColumn(width, [next], extent[0])) {
      return { headerRowIndex: index, leadingRowsSkipped: index, columnOffset: extent[0] };
    }
  }
  const firstData = spans.findIndex((extent) => extent !== null);
  const offsets = spans.filter((extent): extent is [number, number] => extent !== null).map(([first]) => first);
  return {
    headerRowIndex: null,
    leadingRowsSkipped: firstData < 0 ? rows.length : firstData,
    columnOffset: offsets.length === 0 ? 0 : Math.min(...offsets),
  };
}

/**
 * Turn header cells into unique column names.
 *
 * Empty or missing header cells become `column_N` (1-based position). A
 * repeated name becomes `name_2`, `name_3`, … with the header text preserved
 * as `originalName`, so a rename is visible rather than silent.
 *
 * @param header Header cells, or null when the table has no header.
 * @param width How many columns the table has.
 * @returns One name per column, and the names that were created by renaming.
 * @example resolveColumnNames(['amount', 'amount'], 2).names[1] // { name: 'amount_2', originalName: 'amount' }
 */
export function resolveColumnNames(
  header: readonly CellValue[] | null,
  width: number,
): { names: ColumnName[]; renamed: string[] } {
  const used = new Set<string>();
  const renamed: string[] = [];
  const names: ColumnName[] = [];
  for (let position = 0; position < width; position += 1) {
    const raw = header?.[position];
    const label = raw === undefined || raw === null ? '' : String(raw).trim();
    const base = label === '' ? `column_${position + 1}` : label;
    let name = base;
    for (let suffix = 2; used.has(name); suffix += 1) name = `${base}_${suffix}`;
    used.add(name);
    const wasRenamed = name !== base && label !== '';
    if (wasRenamed) renamed.push(name);
    names.push({ name, originalName: wasRenamed ? label : null });
  }
  return { names, renamed };
}
