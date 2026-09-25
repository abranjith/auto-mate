// ---------------------------------------------------------------------------
// Table profiling over a row iterator (FEAT-104 TASK-003).
//
// Module invariant: pure over an iterator — no file handles, no parser
// library, no Node built-ins. CSV and XLSX readers both feed this one code
// path, so the statistics cannot drift between formats.
//
// What survives profiling is aggregates plus the first `SAMPLE_ROW_COUNT`
// non-blank rows with cells truncated. Ragged and blank rows are COUNTED even
// though they are not sampled, which is how head-only sampling still surfaces
// a footer row. Anything that would change the meaning of the data — an
// ambiguous date, a mixed column, a missing header — becomes a structured
// note, never a silent decision.
// ---------------------------------------------------------------------------

import type { CsvDialectInfo, ColumnProfile, ProfileNote, TableProfile } from '../contracts/upload-api';
import { NoTabularContentError, TooManyColumnsError } from '../errors/ingestion-errors';
import { ColumnAccumulator } from './column-accumulator';
import { isBlankRow, resolveColumnNames } from './header-detection';
import { SAMPLE_CELL_MAX_CHARS, SAMPLE_ROW_COUNT, TRUNCATION_MARKER } from './limits';
import { cellText, type CellValue } from './type-inference';

/** Rows plus what the reader already decided about them. */
export interface TableSource {
  readonly rows: AsyncIterable<readonly CellValue[]> | Iterable<readonly CellValue[]>;
  /** Header cells, already consumed from `rows`; null when the table has none. */
  readonly header: readonly CellValue[] | null;
  readonly headerRowIndex: number | null;
  /** The width the reader expects (the sniffed modal field count), used when wider than the header. */
  readonly expectedWidth?: number;
  /** Title and blank rows the reader skipped above the table. */
  readonly leadingRowsSkipped?: number;
  /**
   * How to count ragged rows. `field-count`: a delimited row whose field count
   * differs from the most common one. `overflow`: a grid row with values beyond
   * the table's last column (grid rows are never short, only sparse).
   */
  readonly raggedMode?: 'field-count' | 'overflow';
  /** Called once iteration ends, for facts only the reader knows. */
  readonly describe?: () => SourceFacts;
}

/** Facts a reader learns while it reads. */
export interface SourceFacts {
  /** The reader stopped at its own row cap before the source ended. */
  readonly truncated?: boolean;
  readonly mergedCellCount?: number;
  readonly formulaCellCount?: number;
  readonly notes?: readonly ProfileNote[];
}

/** Where the table sits in its file. */
export interface TableMeta {
  readonly sheetName: string | null;
  readonly sheetIndex: number;
  readonly isHidden: boolean;
  readonly delimiter: string | null;
  readonly dialect: CsvDialectInfo | null;
}

/** Limits and the determinism seed. */
export interface ProfileOptions {
  /** The file's SHA-256; seeds every column's reservoir. */
  readonly seed: string;
  /** Rows scanned (blank or not) before the count becomes a lower bound. */
  readonly maxRows: number;
  readonly maxColumns: number;
  readonly signal?: AbortSignal;
}

/** Rows between cooperative cancellation checks. */
const SIGNAL_CHECK_INTERVAL = 1_024;

/**
 * Truncate a sample cell to `SAMPLE_CELL_MAX_CHARS`, marker included, without splitting a surrogate pair.
 *
 * @param text Cell text.
 * @returns The text, or its truncated form ending in `…`.
 * @example truncateCell('x'.repeat(300)).length // 200
 */
export function truncateCell(text: string): string {
  if (text.length <= SAMPLE_CELL_MAX_CHARS) return text;
  let cut = SAMPLE_CELL_MAX_CHARS - TRUNCATION_MARKER.length;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return text.slice(0, cut) + TRUNCATION_MARKER;
}

/** Mutable single-pass state for one table. */
class TableScan {
  columns: ColumnAccumulator[] = [];
  width = 0;
  scanned = 0;
  dataRows = 0;
  blankRows = 0;
  overflowRows = 0;
  truncated = false;
  readonly fieldCounts = new Map<number, number>();
  readonly sample: string[][] = [];

  constructor(
    private readonly options: ProfileOptions,
    private readonly meta: TableMeta,
  ) {}

  allocate(width: number): void {
    if (width > this.options.maxColumns) throw new TooManyColumnsError(width, this.options.maxColumns, this.meta.sheetName ?? undefined);
    this.width = width;
    const seed = `${this.options.seed}:${this.meta.sheetIndex}`;
    this.columns = Array.from({ length: width }, (_, position) => new ColumnAccumulator(`${seed}:${position}`));
  }

  consume(row: readonly CellValue[]): void {
    this.scanned += 1;
    if (isBlankRow(row)) {
      this.blankRows += 1;
      return;
    }
    if (this.columns.length === 0 && this.width === 0) this.allocate(row.length);
    this.dataRows += 1;
    this.fieldCounts.set(row.length, (this.fieldCounts.get(row.length) ?? 0) + 1);
    if (row.length > this.width && row.slice(this.width).some((cell) => cellText(cell ?? null).trim() !== '')) this.overflowRows += 1;
    for (let position = 0; position < this.width; position += 1) this.columns[position]!.push(row[position] ?? null);
    if (this.sample.length < SAMPLE_ROW_COUNT) {
      this.sample.push(Array.from({ length: this.width }, (_, position) => truncateCell(cellText(row[position] ?? null))));
    }
  }
}

async function scanRows(source: TableSource, scan: TableScan, options: ProfileOptions): Promise<void> {
  for await (const row of source.rows) {
    if (scan.scanned % SIGNAL_CHECK_INTERVAL === 0) options.signal?.throwIfAborted();
    if (scan.scanned >= options.maxRows) {
      scan.truncated = true;
      return;
    }
    scan.consume(row);
  }
}

function raggedCount(scan: TableScan, mode: TableSource['raggedMode']): number {
  if (mode === 'overflow') return scan.overflowRows;
  let modal = 0;
  let best = 0;
  for (const [width, count] of scan.fieldCounts) if (count > best) [modal, best] = [width, count];
  return scan.dataRows - (scan.fieldCounts.get(modal) ?? 0);
}

function columnNotes(columns: readonly ColumnProfile[]): ProfileNote[] {
  const notes: ProfileNote[] = [];
  for (const column of columns) {
    const stats = column.stats;
    if (stats?.kind === 'temporal' && stats.ambiguous && stats.alternateFormat !== null) {
      notes.push({ code: 'ambiguous_date_format', column: truncateCell(column.name), formats: [stats.detectedFormat, stats.alternateFormat] });
    }
    if (column.isMixedType) {
      const matching = Math.round(column.typeConfidence * column.valueCount);
      notes.push({ code: 'mixed_type_column', column: truncateCell(column.name), count: column.valueCount - matching });
    }
  }
  return notes;
}

function tableNotes(input: { source: TableSource; meta: TableMeta; options: ProfileOptions; scan: TableScan; renamed: string[]; ragged: number; facts: SourceFacts }): ProfileNote[] {
  const { source, meta, options, scan, renamed, ragged, facts } = input;
  const notes: ProfileNote[] = [];
  const add = (condition: boolean, note: ProfileNote) => condition && notes.push(note);
  add(source.header === null, { code: 'no_header_detected' });
  add(renamed.length > 0, { code: 'duplicate_headers_renamed', count: renamed.length, columns: renamed.slice(0, 20).map(truncateCell) });
  add((source.leadingRowsSkipped ?? 0) > 0, { code: 'leading_blank_rows_skipped', count: source.leadingRowsSkipped ?? 0 });
  add(scan.truncated || facts.truncated === true, { code: 'row_cap_reached', limit: options.maxRows });
  add(ragged > 0, { code: 'ragged_rows', count: ragged });
  add(scan.blankRows > 0, { code: 'blank_rows', count: scan.blankRows });
  add(meta.isHidden, { code: 'hidden_sheet' });
  add((facts.mergedCellCount ?? 0) > 0, { code: 'merged_cells', count: facts.mergedCellCount ?? 0 });
  add((facts.formulaCellCount ?? 0) > 0, { code: 'formula_cells', count: facts.formulaCellCount ?? 0 });
  return [...notes, ...(facts.notes ?? [])];
}

function buildColumns(scan: TableScan, header: TableSource['header']): { columns: ColumnProfile[]; renamed: string[] } {
  const { names, renamed } = resolveColumnNames(header, scan.width);
  const columns = scan.columns.map((accumulator, position): ColumnProfile => ({
    position,
    name: names[position]!.name,
    originalName: names[position]!.originalName,
    ...accumulator.summarize(),
  }));
  return { columns, renamed };
}

/**
 * Profile one table in a single pass over its rows.
 *
 * @param source Rows (header already consumed) and the reader's decisions.
 * @param meta Where the table sits in its file.
 * @param options Seed, limits, and an optional cancellation signal.
 * @returns The table's profile. The same rows and seed always give identical output.
 * @throws TooManyColumnsError when the table is wider than `maxColumns`.
 * @throws NoTabularContentError when there is neither a header nor a non-blank row.
 * @throws The signal's reason when it aborts.
 */
export async function profileTable(source: TableSource, meta: TableMeta, options: ProfileOptions): Promise<TableProfile> {
  const scan = new TableScan(options, meta);
  const declaredWidth = Math.max(source.header?.length ?? 0, source.expectedWidth ?? 0);
  if (declaredWidth > 0) scan.allocate(declaredWidth);
  await scanRows(source, scan, options);
  if (scan.dataRows === 0 && source.header === null) throw new NoTabularContentError(meta.sheetName ?? undefined);
  const facts = source.describe?.() ?? {};
  const ragged = raggedCount(scan, source.raggedMode);
  const { columns, renamed } = buildColumns(scan, source.header);
  return {
    ...meta,
    rowCount: scan.dataRows,
    rowCountExact: !scan.truncated && facts.truncated !== true,
    columnCount: scan.width,
    hasHeader: source.header !== null,
    headerRowIndex: source.header === null ? null : source.headerRowIndex,
    raggedRowCount: ragged,
    blankRowCount: scan.blankRows,
    mergedCellCount: facts.mergedCellCount ?? 0,
    formulaCellCount: facts.formulaCellCount ?? 0,
    sampleRows: scan.sample,
    notes: [...tableNotes({ source, meta, options, scan, renamed, ragged, facts }), ...columnNotes(columns)],
    columns,
  };
}
