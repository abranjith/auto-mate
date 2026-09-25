// ---------------------------------------------------------------------------
// XLSX reading pipeline (FEAT-104 TASK-007).
//
// Workbooks are read ONLY with exceljs's streaming `WorkbookReader`. The
// in-memory loader retained 732 MB for an 11.4 MB file and
// died under a 256 MB heap; the streaming reader retained 35 MB. A test
// guards this choice.
//
// This module yields rows; it computes no statistics. Typed cells (number,
// date, boolean) arrive as their JS types; a formula contributes its CACHED
// RESULT, never its text, and is counted.
//
// Three guards against a 50 MB workbook that expands to gigabytes: inflated
// bytes are counted as they leave the decompressor and reading aborts past a
// budget; the shared-string table has its own smaller budget (it is held in
// memory); and the row cap and parse timeout bound the rest.
//
// Two small, contained interventions in the zip layer are made through the
// input stream's `pipe`, because exceljs exposes no hook there:
// - counting inflated bytes per entry (the guard above), and
// - suppressing a premature `end` that unzipper 0.10 emits from its writable
//   `finish` handler while parsed entries are still buffered. exceljs trusts
//   that event and silently drops the buffered entries — including
//   `xl/workbook.xml` when it comes last, as it does in files written with
//   ZIP data descriptors — and then crashes on a missing workbook model.
// Both depend on exceljs 4.4.0 / unzipper 0.10.14 internals, pinned exactly;
// the tests that exercise them fail loudly if an upgrade changes either.
// ---------------------------------------------------------------------------

import { createReadStream } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import ExcelJS from 'exceljs';
import {
  AutoMateError,
  HEADER_SCAN_ROWS,
  ParseFailedError,
  WorkbookTooLargeError,
  findSheetHeader,
  type CellValue,
  type ProfileNote,
  type SourceFacts,
} from '@automate/core';

/** The shared-string table may use at most this share of the inflation budget: it is held in memory whole. */
export const SHARED_STRINGS_BUDGET_SHARE = 0.25;
/** Rows read ahead for header detection: the candidate window plus a few to see what follows it. */
const HEADER_LOOKAHEAD_ROWS = HEADER_SCAN_ROWS + 5;
const SHARED_STRINGS_ENTRY = 'xl/sharedStrings.xml';

export interface XlsxReaderOptions {
  readonly maxSheets: number;
  readonly maxInflatedBytes: number;
  readonly signal?: AbortSignal;
  /** Test seam: how to open the file's byte stream. */
  readonly openStream?: (filePath: string) => Readable;
}

/** One worksheet, ready to profile. Its rows must be consumed (or abandoned) before the next sheet is requested. */
export interface XlsxSheet {
  readonly name: string;
  /** Position in the workbook's tab order. */
  readonly index: number;
  readonly hidden: boolean;
  readonly header: CellValue[] | null;
  readonly headerRowIndex: number | null;
  readonly leadingRowsSkipped: number;
  readonly expectedWidth: number;
  /** Data rows after the header, re-based to the table's first column. */
  readonly rows: AsyncIterable<CellValue[]>;
  /** Facts learned while reading: merged and formula cell counts. */
  describe(): SourceFacts;
}

/** Facts about the whole workbook, complete once iteration ends. */
export interface WorkbookFacts {
  totalSheets: number;
  sheetsRead: number;
  inflatedBytes: number;
  notes: ProfileNote[];
}

// Structural views of the exceljs objects this module touches; its typings omit several.
interface ExcelCell {
  readonly value: unknown;
  readonly numFmt?: string;
}
interface ExcelRow {
  readonly number: number;
  eachCell(options: { includeEmpty: boolean }, visit: (cell: ExcelCell, column: number) => void): void;
}
interface ExcelSheet extends AsyncIterable<ExcelRow> {
  readonly name: string;
  readonly state?: string;
  iterator: AsyncIterable<unknown>;
}
interface ExcelWorkbookReader extends AsyncIterable<ExcelSheet> {
  readonly model?: { readonly sheets?: readonly { readonly name: string }[] };
  readonly properties?: { readonly model?: { readonly date1904?: boolean } };
}
interface ZipEntry {
  readonly path: string;
  push(chunk: unknown, encoding?: BufferEncoding): boolean;
  destroy(error?: Error): void;
  once(event: 'end' | 'close', listener: () => void): void;
}

/** Tracks inflated bytes against the budgets and tears the zip layer down when one is exceeded. */
class InflationGuard {
  inflated = 0;
  private shared = 0;
  failure: Error | null = null;
  private zip: Writable | null = null;
  /** Entries still being read, with their original `push`, so a failure can end them cleanly. */
  private readonly live = new Map<ZipEntry, ZipEntry['push']>();

  constructor(
    private readonly input: Readable,
    private readonly budget: number,
  ) {}

  attach(zip: Writable): void {
    this.zip = zip;
  }

  track(entry: ZipEntry, push: ZipEntry['push']): void {
    this.live.set(entry, push);
    const forget = () => this.live.delete(entry);
    entry.once('end', forget);
    entry.once('close', forget);
  }

  /** Count bytes leaving the decompressor for one entry; returns false once reading must stop. */
  count(entry: ZipEntry, bytes: number): boolean {
    if (this.failure) return false;
    this.inflated += bytes;
    if (entry.path === SHARED_STRINGS_ENTRY) this.shared += bytes;
    const sharedBudget = Math.floor(this.budget * SHARED_STRINGS_BUDGET_SHARE);
    if (this.inflated > this.budget) this.fail(new WorkbookTooLargeError(this.inflated, this.budget));
    else if (this.shared > sharedBudget) this.fail(new WorkbookTooLargeError(this.shared, sharedBudget, 'shared-strings'));
    return this.failure === null;
  }

  /**
   * Stop everything so no consumer waits forever. Live entries are ENDED rather
   * than destroyed: exceljs may be spooling one to a temp file through
   * `pipe`, which neither forwards an error nor finishes on destroy. Ending it
   * lets that step complete; the error then reaches exceljs through the
   * destroyed unzipper on its next read.
   */
  fail(error: Error): void {
    this.failure ??= error;
    for (const push of this.live.values()) push(null);
    this.live.clear();
    this.zip?.destroy(this.failure);
    this.input.destroy();
  }

  /** Release every stream after a normal finish or an abandoned read. Idempotent. */
  shutdown(): void {
    for (const entry of this.live.keys()) entry.destroy();
    this.live.clear();
    this.zip?.destroy();
    this.input.destroy();
  }
}

function isZipEntry(chunk: unknown): chunk is ZipEntry {
  return typeof chunk === 'object' && chunk !== null && typeof (chunk as { path?: unknown }).path === 'string' && typeof (chunk as { push?: unknown }).push === 'function';
}

/** Count every byte an entry's decompressor pushes, whether it is parsed, spooled to a temp file, or drained. */
function meterEntry(entry: ZipEntry, guard: InflationGuard): void {
  const push = entry.push.bind(entry);
  guard.track(entry, push);
  entry.push = (chunk, encoding) => {
    if (chunk === null || chunk === undefined) return push(chunk, encoding);
    const size = (chunk as { length?: number }).length ?? 0;
    return guard.count(entry, size) ? push(chunk, encoding) : false;
  };
}

/** Intercept the unzipper instance exceljs pipes the input into. See the module comment for why. */
function instrumentZip(input: Readable, guard: InflationGuard): void {
  const pipe = input.pipe.bind(input);
  input.pipe = (<T extends NodeJS.WritableStream>(destination: T, options?: { end?: boolean }): T => {
    const zip = destination as unknown as Writable & Readable;
    guard.attach(zip);
    const push = zip.push.bind(zip);
    zip.push = (chunk: unknown, encoding?: BufferEncoding) => {
      if (isZipEntry(chunk)) meterEntry(chunk, guard);
      return push(chunk, encoding);
    };
    const emit = zip.emit.bind(zip);
    zip.emit = ((event: string | symbol, ...args: unknown[]) =>
      event === 'end' && zip.readableLength > 0 ? false : emit(event, ...args)) as typeof zip.emit;
    return pipe(destination, options);
  }) as typeof input.pipe;
}

/** Days between Excel's 1900-system epoch (1899-12-30) and the Unix epoch. */
const EXCEL_UNIX_OFFSET_DAYS = 25_569;
/** Extra days in the 1904 date system. */
const EXCEL_1904_OFFSET_DAYS = 1_462;
const MS_PER_DAY = 86_400_000;

/**
 * Convert an Excel serial date to a UTC `Date`, as exceljs does for date-formatted cells.
 *
 * @param serial Days since the workbook's epoch.
 * @param date1904 Whether the workbook uses the 1904 date system.
 * @returns The instant, treating the serial as UTC.
 */
export function excelSerialToDate(serial: number, date1904: boolean): Date {
  const days = serial + (date1904 ? EXCEL_1904_OFFSET_DAYS : 0) - EXCEL_UNIX_OFFSET_DAYS;
  return new Date(Math.round(days * MS_PER_DAY));
}

/**
 * Whether a number format displays a date or time (the rule exceljs applies to plain cells).
 *
 * @param format A cell's number format code.
 * @returns True when, outside brackets and quoted text, it contains a date or time token.
 */
export function isDateFormat(format: string | undefined): boolean {
  if (!format) return false;
  const bare = format.replace(/\[[^\]]*]/g, '').replace(/"[^"]*"/g, '');
  return /[ymdhMsb]+/.test(bare);
}

interface SheetState {
  merges: number;
  formulas: number;
}

/** A formula contributes its cached result, never its text; a date-formatted numeric result becomes a date. */
function formulaResult(result: unknown, cell: ExcelCell, date1904: boolean): CellValue {
  if (result === undefined || result === null) return null;
  if (typeof result === 'number') return isDateFormat(cell.numFmt) ? excelSerialToDate(result, date1904) : result;
  if (typeof result === 'string' || typeof result === 'boolean' || result instanceof Date) return result;
  if (typeof result === 'object' && 'error' in result) return String((result as { error: unknown }).error);
  return null;
}

/**
 * Turn one exceljs cell into a profiler cell.
 *
 * @param cell The cell as the streaming reader produced it.
 * @param state Per-sheet counters; formulas are counted here.
 * @param date1904 Whether the workbook uses the 1904 date system.
 * @returns A typed value: number, string, boolean, Date, or null.
 */
export function toCellValue(cell: ExcelCell, state: SheetState, date1904: boolean): CellValue {
  const raw = cell.value;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean' || raw instanceof Date) return raw;
  if (typeof raw !== 'object') return null;
  if ('formula' in raw || 'sharedFormula' in raw) {
    state.formulas += 1;
    return formulaResult((raw as { result?: unknown }).result, cell, date1904);
  }
  if ('richText' in raw) {
    const runs = (raw as { richText: readonly { text?: unknown }[] }).richText;
    return runs.map((run) => (typeof run.text === 'string' ? run.text : '')).join('');
  }
  if ('error' in raw) return String((raw as { error: unknown }).error);
  if ('text' in raw) return String((raw as { text: unknown }).text);
  return null;
}

function rowValues(row: ExcelRow, state: SheetState, date1904: boolean): CellValue[] {
  const values: CellValue[] = [];
  row.eachCell({ includeEmpty: false }, (cell, column) => {
    values[column - 1] = toCellValue(cell, state, date1904);
  });
  return Array.from(values, (value) => value ?? null);
}

/** Yield every row in order, with an empty row for each row number the sheet XML skips. */
async function* denseRows(sheet: ExcelSheet, state: SheetState, date1904: boolean): AsyncGenerator<CellValue[]> {
  let expected = 1;
  for await (const row of sheet) {
    for (; expected < row.number; expected += 1) yield [];
    expected = row.number + 1;
    yield rowValues(row, state, date1904);
  }
}

/**
 * Pass a sheet's raw XML through unchanged while counting `<mergeCell>` elements
 * (exceljs's streaming reader parses and discards them), and honouring the signal.
 */
async function* countMerges(source: AsyncIterable<unknown>, state: SheetState, signal: AbortSignal | undefined): AsyncGenerator<unknown> {
  let tail = '';
  for await (const chunk of source) {
    signal?.throwIfAborted();
    const text = tail + (Buffer.isBuffer(chunk) ? chunk.toString('latin1') : String(chunk));
    state.merges += (text.match(/<mergeCell[\s/>]/g) ?? []).length;
    // Shorter than the tag, so a match can never lie wholly inside the carried tail and be counted twice.
    tail = text.slice(-10);
    yield chunk;
  }
}

function isEmpty(cell: CellValue | undefined): boolean {
  return cell === null || cell === undefined || (typeof cell === 'string' && cell.trim() === '');
}

/** Columns from `offset` through the last populated cell. */
function populatedWidth(row: readonly CellValue[], offset: number): number {
  for (let index = row.length - 1; index >= offset; index -= 1) if (!isEmpty(row[index])) return index - offset + 1;
  return 0;
}

/** Replay the look-ahead rows, then the rest of the sheet, re-based to the table's first column. */
async function* rebased(
  buffered: readonly CellValue[][],
  source: AsyncIterator<CellValue[]>,
  offset: number,
  translate: (cause: unknown) => unknown,
): AsyncGenerator<CellValue[]> {
  const shift = (row: CellValue[]) => (offset === 0 ? row : row.slice(offset));
  try {
    for (const row of buffered) yield shift(row);
    for (let next = await source.next(); !next.done; next = await source.next()) yield shift(next.value);
    // A budget failure ends the entry cleanly; the sheet must still read as failed, not as short.
    const failed = translate(null);
    if (failed !== null) throw failed;
  } catch (cause) {
    throw translate(cause);
  } finally {
    await source.return?.(undefined);
  }
}

/** An open workbook: a one-shot sheet iterator plus facts complete once it ends. */
export interface XlsxWorkbook {
  readonly sheets: AsyncIterable<XlsxSheet>;
  readonly facts: WorkbookFacts;
  /** Release the file and the unzipper. Idempotent; call it in a `finally`. */
  close(): void;
}

interface WorkbookContext {
  readonly reader: ExcelWorkbookReader;
  readonly guard: InflationGuard;
  readonly options: XlsxReaderOptions;
  readonly translate: (cause: unknown) => unknown;
}

/**
 * Turn anything thrown while reading into an application error.
 * Budget failures and cancellation keep their identity; everything else is a
 * damaged-workbook message, never exceljs's or unzipper's own text.
 */
function translator(guard: InflationGuard, signal: AbortSignal | undefined): (cause: unknown) => unknown {
  return (cause) => {
    if (guard.failure && !signal?.aborted) return guard.failure;
    if (signal?.aborted) return signal.reason ?? cause;
    if (cause === null) return null;
    if (cause instanceof AutoMateError) return cause;
    return new ParseFailedError('The workbook is damaged or is not a real Excel workbook. Open it in Excel, save it again as .xlsx, and attach the new file.');
  };
}

async function prepareSheet(sheet: ExcelSheet, position: number, context: WorkbookContext): Promise<XlsxSheet> {
  const state: SheetState = { merges: 0, formulas: 0 };
  sheet.iterator = countMerges(sheet.iterator, state, context.options.signal);
  const date1904 = context.reader.properties?.model?.date1904 === true;
  const source = denseRows(sheet, state, date1904)[Symbol.asyncIterator]();
  const lookahead: CellValue[][] = [];
  try {
    while (lookahead.length < HEADER_LOOKAHEAD_ROWS) {
      const next = await source.next();
      if (next.done) break;
      lookahead.push(next.value);
    }
  } catch (cause) {
    await source.return?.(undefined);
    throw context.translate(cause);
  }
  const scan = findSheetHeader(lookahead);
  const headerRow = scan.headerRowIndex === null ? null : lookahead[scan.headerRowIndex]!;
  const header = headerRow === null ? null : headerRow.slice(scan.columnOffset, scan.columnOffset + populatedWidth(headerRow, scan.columnOffset));
  const buffered = lookahead.slice(scan.headerRowIndex === null ? scan.leadingRowsSkipped : scan.headerRowIndex + 1);
  const tabIndex = context.reader.model?.sheets?.findIndex(({ name }) => name === sheet.name) ?? -1;
  return {
    name: sheet.name,
    index: tabIndex >= 0 ? tabIndex : position,
    hidden: sheet.state === 'hidden' || sheet.state === 'veryHidden',
    header,
    headerRowIndex: scan.headerRowIndex,
    leadingRowsSkipped: scan.leadingRowsSkipped,
    expectedWidth: Math.max(header?.length ?? 0, ...buffered.map((row) => populatedWidth(row, scan.columnOffset))),
    rows: rebased(buffered, source, scan.columnOffset, context.translate),
    describe: () => ({ mergedCellCount: state.merges, formulaCellCount: state.formulas }),
  };
}

async function* sheetsOf(context: WorkbookContext, facts: WorkbookFacts): AsyncGenerator<XlsxSheet> {
  const { reader, options } = context;
  try {
    for await (const sheet of reader) {
      facts.totalSheets = Math.max(facts.totalSheets, reader.model?.sheets?.length ?? 0, facts.sheetsRead + 1);
      if (facts.sheetsRead >= options.maxSheets) {
        facts.notes.push({ code: 'sheet_cap_reached', limit: options.maxSheets, count: facts.totalSheets });
        return;
      }
      facts.sheetsRead += 1;
      yield await prepareSheet(sheet, facts.sheetsRead - 1, context);
    }
  } catch (cause) {
    throw context.translate(cause);
  } finally {
    facts.inflatedBytes = context.guard.inflated;
  }
}

/**
 * Open an XLSX workbook for streaming, sheet by sheet.
 *
 * @param filePath Absolute path of a file already inside the data root.
 * @param options Sheet cap, inflation budget, cancellation, and a test seam.
 * @returns The sheets in the order the file stores them (each carries its tab-order index), and workbook facts.
 * @throws WorkbookTooLargeError (during iteration) when the workbook expands past its budget.
 * @throws ParseFailedError (during iteration) for a damaged workbook.
 * @example
 * const workbook = openWorkbook(path, { maxSheets: 20, maxInflatedBytes: 1 << 30 });
 * try { for await (const sheet of workbook.sheets) await profile(sheet); } finally { workbook.close(); }
 */
export function openWorkbook(filePath: string, options: XlsxReaderOptions): XlsxWorkbook {
  const input = (options.openStream ?? ((path: string) => createReadStream(path)))(filePath);
  const guard = new InflationGuard(input, options.maxInflatedBytes);
  instrumentZip(input, guard);
  const onAbort = () => guard.fail(options.signal?.reason instanceof Error ? options.signal.reason : new Error('Reading was cancelled.'));
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(input, {
    worksheets: 'emit',
    sharedStrings: 'cache',
    // Styles carry number formats; without them date cells arrive as bare serial numbers.
    styles: 'cache',
    hyperlinks: 'ignore',
    entries: 'emit',
  }) as unknown as ExcelWorkbookReader;
  const facts: WorkbookFacts = { totalSheets: 0, sheetsRead: 0, inflatedBytes: 0, notes: [] };
  const context: WorkbookContext = { reader, guard, options, translate: translator(guard, options.signal) };
  return {
    sheets: sheetsOf(context, facts),
    facts,
    close: () => {
      options.signal?.removeEventListener('abort', onAbort);
      guard.shutdown();
    },
  };
}
