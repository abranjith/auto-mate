// ---------------------------------------------------------------------------
// The disclosure payload (FEAT-104 TASK-004).
//
// INVARIANT: this function's output is the complete set of user data the
// application is permitted to transmit; anything not in it never leaves the
// machine.
//
// Module invariant: pure and deterministic. Given the same upload and
// profiles it returns the same payload, byte for byte — no clock, no
// randomness, no I/O, no Node built-ins.
//
// The payload is bounded at `DISCLOSURE_MAX_BYTES` of serialized UTF-8. When
// the full description is larger, it degrades in a FIXED order and records
// every step in `truncations`, so a person can be told exactly what was left
// out rather than being shown a silently shortened picture:
//
//   0. limit_notes        — at most 50 notes per table (always applied)
//   1. drop_top_values    — largest tables first
//   2. reduce_sample_rows — every table, from 10 toward 3
//   3. drop_sample_rows   — from every table but the first
//   4. truncate_columns   — keep the first N columns of every table
//   5. omit_tables        — drop trailing tables (a last resort that makes
//                           the ceiling unconditional)
// ---------------------------------------------------------------------------

import type {
  ColumnProfile,
  DisclosedColumn,
  DisclosedTable,
  DisclosurePayload,
  FileFormat,
  ProfileNote,
  TableProfile,
  Truncation,
} from '../contracts/upload-api';
import { DISCLOSURE_MAX_BYTES, SAMPLE_ROW_COUNT, TOP_VALUES_COUNT } from './limits';
import { truncateCell } from './table-profiler';

/** The upload fields a payload describes. */
export interface DisclosureUpload {
  readonly originalFilename: string;
  readonly format: FileFormat;
  readonly byteSize: number;
  readonly sha256: string;
  readonly encoding: string | null;
}

/** Options for tests; production always uses the D04 ceiling. */
export interface DisclosureOptions {
  readonly maxBytes?: number;
}

/** Notes kept per table before `limit_notes` applies. */
export const MAX_NOTES_PER_TABLE = 50;
/** The fewest sample rows step 2 reduces to before step 3 removes them. */
const MIN_SAMPLE_ROWS = 3;

/**
 * Count the UTF-8 bytes of a string without allocating an encoded copy.
 *
 * @param text Any string. Lone surrogates count as the 3-byte replacement a UTF-8 encoder would write.
 * @returns The byte length.
 * @example utf8ByteLength('é') // 2
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * The size of a payload as it will be transmitted: serialized JSON in UTF-8.
 *
 * @param payload A disclosure payload.
 * @returns Its exact serialized byte length.
 */
export function estimatePayloadBytes(payload: DisclosurePayload): number {
  return utf8ByteLength(JSON.stringify(payload));
}

/** The last segment of a client-supplied name, capped like a cell, so no directory ever enters a payload. */
function displayName(original: string): string {
  return truncateCell(original.split(/[\\/]/).pop() ?? '');
}

function discloseNote(note: ProfileNote): ProfileNote {
  return {
    code: note.code,
    ...(note.column === undefined ? {} : { column: truncateCell(note.column) }),
    ...(note.columns === undefined ? {} : { columns: note.columns.slice(0, 20).map(truncateCell) }),
    ...(note.count === undefined ? {} : { count: note.count }),
    ...(note.limit === undefined ? {} : { limit: note.limit }),
    ...(note.formats === undefined ? {} : { formats: note.formats.slice(0, 4).map((format) => format.slice(0, 64)) }),
  };
}

/** Copy a column, enforcing the high-cardinality rule here too: no values leave for a high-cardinality column. */
function discloseColumn(column: ColumnProfile): DisclosedColumn {
  const highCardinality = column.isHighCardinality;
  return {
    position: column.position,
    name: truncateCell(column.name),
    originalName: column.originalName === null ? null : truncateCell(column.originalName),
    inferredType: column.inferredType,
    typeConfidence: column.typeConfidence,
    isMixedType: column.isMixedType,
    nullCount: column.nullCount,
    blankCount: column.blankCount,
    distinctCount: highCardinality ? null : column.distinctCount,
    isHighCardinality: highCardinality,
    stats: column.stats,
    topValues:
      highCardinality || column.topValues === null
        ? null
        : column.topValues.slice(0, TOP_VALUES_COUNT).map(({ value, count }) => ({ value: truncateCell(value), count })),
  };
}

function discloseTable(profile: TableProfile, truncations: Truncation[]): DisclosedTable {
  const notes = profile.notes.slice(0, MAX_NOTES_PER_TABLE).map(discloseNote);
  const omittedNotes = profile.notes.length - notes.length;
  if (omittedNotes > 0) truncations.push({ step: 'limit_notes', sheetIndex: profile.sheetIndex, kept: notes.length, omitted: omittedNotes });
  return {
    sheetName: profile.sheetName === null ? null : truncateCell(profile.sheetName),
    sheetIndex: profile.sheetIndex,
    isHidden: profile.isHidden,
    rowCount: profile.rowCount,
    rowCountExact: profile.rowCountExact,
    columnCount: profile.columnCount,
    hasHeader: profile.hasHeader,
    delimiter: profile.delimiter,
    columns: profile.columns.map(discloseColumn),
    omittedColumnCount: 0,
    sampleRows: profile.sampleRows.slice(0, SAMPLE_ROW_COUNT).map((row) => row.slice(0, profile.columns.length).map(truncateCell)),
    notes,
  };
}

/** How far the ladder has cut one table down. */
interface TablePlan {
  topValues: boolean;
  sampleRows: number;
  columns: number;
}

const jsonBytes = (value: unknown) => utf8ByteLength(JSON.stringify(value));
const total = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0);
/** Bytes between the brackets of a JSON array whose items have the given total size. */
const arrayContent = (itemBytes: number, count: number) => itemBytes + Math.max(0, count - 1);

function prefixSums(values: readonly number[]): number[] {
  const sums = [0];
  for (const value of values) sums.push(sums.at(-1)! + value);
  return sums;
}

/** Keep only the notes that still refer to a kept column. */
function keepNotes(notes: readonly ProfileNote[], names: ReadonlySet<string>): ProfileNote[] {
  return notes
    .filter((note) => note.column === undefined || names.has(note.column))
    .map((note) => (note.columns === undefined ? note : { ...note, columns: note.columns.filter((name) => names.has(name)) }));
}

/** Keep the first `kept` columns of a table, with its sample cells and per-column notes. */
function keepColumns(table: DisclosedTable, kept: number): DisclosedTable {
  if (table.columns.length <= kept) return table;
  const columns = table.columns.slice(0, kept);
  return {
    ...table,
    columns,
    omittedColumnCount: table.columns.length - kept,
    sampleRows: table.sampleRows.map((row) => row.slice(0, kept)),
    notes: keepNotes(table.notes, new Set(columns.map(({ name }) => name))),
  };
}

/**
 * Byte sizes of one disclosed table's parts, measured once.
 *
 * Every ladder step changes only how many columns, rows, or frequent values
 * are kept, so its size is arithmetic over these prefix sums rather than a
 * re-serialization of a table that can run to megabytes before degradation.
 */
class TableSizer {
  private readonly skeleton: number;
  private readonly columnSums: number[];
  private readonly bareColumnSums: number[];
  private readonly cellSums: number[][];
  private readonly noteBytes: number;

  constructor(readonly table: DisclosedTable) {
    this.skeleton = jsonBytes({ ...table, columns: [], sampleRows: [], notes: [] });
    this.columnSums = prefixSums(table.columns.map(jsonBytes));
    this.bareColumnSums = prefixSums(table.columns.map((column) => jsonBytes({ ...column, topValues: null })));
    this.cellSums = table.sampleRows.map((row) => prefixSums(row.map(jsonBytes)));
    this.noteBytes = arrayContent(total(table.notes.map(jsonBytes)), table.notes.length);
  }

  get hasTopValues(): boolean {
    return this.table.columns.some((column) => column.topValues !== null);
  }

  size(plan: TablePlan): number {
    const kept = Math.min(plan.columns, this.table.columns.length);
    const omitted = this.table.columns.length - kept;
    const sums = plan.topValues ? this.columnSums : this.bareColumnSums;
    const rows = this.cellSums.slice(0, plan.sampleRows).map((cells) => {
      const width = Math.min(kept, cells.length - 1);
      return 2 + arrayContent(cells[width]!, width);
    });
    const notes = omitted === 0 ? this.noteBytes : this.keptNoteBytes(kept);
    return this.skeleton + String(omitted).length - 1 + arrayContent(sums[kept]!, kept) + arrayContent(total(rows), rows.length) + notes;
  }

  private keptNoteBytes(kept: number): number {
    const notes = keepNotes(this.table.notes, new Set(this.table.columns.slice(0, kept).map(({ name }) => name)));
    return arrayContent(total(notes.map(jsonBytes)), notes.length);
  }

  materialize(plan: TablePlan): DisclosedTable {
    const cut = keepColumns(this.table, plan.columns);
    return {
      ...cut,
      columns: plan.topValues ? cut.columns : cut.columns.map((column) => ({ ...column, topValues: null })),
      sampleRows: cut.sampleRows.slice(0, plan.sampleRows),
    };
  }
}

/**
 * One run of the degradation ladder over precomputed sizes.
 *
 * Every step records its truncation BEFORE measuring, so the record's own
 * bytes are inside the ceiling it is checked against.
 */
class Ladder {
  private readonly sizers: TableSizer[];
  private readonly plans: TablePlan[];
  private readonly base: number;
  private tableCount: number;
  private truncations: Truncation[];

  constructor(
    private readonly payload: DisclosurePayload,
    private readonly maxBytes: number,
  ) {
    this.sizers = payload.tables.map((table) => new TableSizer(table));
    this.plans = payload.tables.map((table) => ({ topValues: true, sampleRows: table.sampleRows.length, columns: table.columns.length }));
    this.base = jsonBytes({ ...payload, tables: [], truncations: [] });
    this.tableCount = payload.tables.length;
    this.truncations = [...payload.truncations];
  }

  fits(): boolean {
    const tables = this.sizers.slice(0, this.tableCount).map((sizer, index) => sizer.size(this.plans[index]!));
    const size = this.base + arrayContent(total(tables), tables.length) + arrayContent(total(this.truncations.map(jsonBytes)), this.truncations.length);
    return size <= this.maxBytes;
  }

  dropTopValues(): boolean {
    const order = this.sizers
      .map((sizer, index) => ({ index, bytes: sizer.size(this.plans[index]!), sheetIndex: sizer.table.sheetIndex }))
      .sort((a, b) => b.bytes - a.bytes || a.sheetIndex - b.sheetIndex);
    for (const { index, sheetIndex } of order) {
      if (!this.sizers[index]!.hasTopValues) continue;
      this.plans[index]!.topValues = false;
      this.truncations.push({ step: 'drop_top_values', sheetIndex });
      if (this.fits()) return true;
    }
    return false;
  }

  reduceSampleRows(): boolean {
    const longest = Math.max(0, ...this.plans.map((plan) => plan.sampleRows));
    for (let kept = Math.min(longest, SAMPLE_ROW_COUNT) - 1; kept >= MIN_SAMPLE_ROWS; kept -= 1) {
      for (const plan of this.plans) plan.sampleRows = Math.min(plan.sampleRows, kept);
      this.truncations.push({ step: 'reduce_sample_rows', kept });
      if (this.fits()) return true;
      if (kept > MIN_SAMPLE_ROWS) this.truncations.pop();
    }
    return false;
  }

  dropSampleRows(): boolean {
    const affected = this.plans.slice(1).filter((plan) => plan.sampleRows > 0);
    if (affected.length === 0) return false;
    for (const plan of affected) plan.sampleRows = 0;
    this.truncations.push({ step: 'drop_sample_rows', omitted: affected.length });
    return this.fits();
  }

  truncateColumns(): boolean {
    const earlier = [...this.truncations];
    const apply = (kept: number) => {
      for (const plan of this.plans) plan.columns = kept;
      const steps = this.sizers
        .filter((sizer) => sizer.table.columns.length > kept)
        .map((sizer): Truncation => ({ step: 'truncate_columns', sheetIndex: sizer.table.sheetIndex, kept, omitted: sizer.table.columns.length - kept }));
      this.truncations = [...earlier, ...steps];
    };
    let [low, high] = [0, Math.max(0, ...this.sizers.map((sizer) => sizer.table.columns.length))];
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      apply(middle);
      if (this.fits()) low = middle;
      else high = middle - 1;
    }
    apply(low);
    return this.fits();
  }

  omitTables(): void {
    const step: Truncation = { step: 'omit_tables', omitted: 0 };
    this.truncations.push(step);
    while (this.tableCount > 0 && !this.fits()) {
      this.tableCount -= 1;
      step.omitted = (step.omitted ?? 0) + 1;
    }
  }

  materialize(): DisclosurePayload {
    const tables = this.sizers.slice(0, this.tableCount).map((sizer, index) => sizer.materialize(this.plans[index]!));
    return { ...this.payload, tables, truncations: this.truncations };
  }
}

/**
 * Re-measure the finished payload for real and, should the arithmetic ever
 * disagree, drop trailing tables until it fits. A backstop that keeps the
 * ceiling unconditional; tests assert it never has to act.
 */
function enforceCeiling(payload: DisclosurePayload, maxBytes: number): DisclosurePayload {
  if (estimatePayloadBytes(payload) <= maxBytes) return payload;
  const step: Truncation = { step: 'omit_tables', omitted: 0 };
  const trimmed: DisclosurePayload = { ...payload, truncations: [...payload.truncations, step] };
  while (trimmed.tables.length > 0 && estimatePayloadBytes(trimmed) > maxBytes) {
    trimmed.tables = trimmed.tables.slice(0, -1);
    step.omitted = (step.omitted ?? 0) + 1;
  }
  return trimmed;
}

/**
 * Build the bounded disclosure payload for one upload.
 *
 * @param upload The stored upload's descriptive fields.
 * @param profiles Its table profiles, in any order (they are ordered by sheet index).
 * @param options Test-only ceiling override.
 * @returns A payload whose serialized UTF-8 length is at or under the ceiling, with every degradation step recorded.
 * @example buildDisclosurePayload(upload, [profile]).truncations // [] for a small file
 */
export function buildDisclosurePayload(
  upload: DisclosureUpload,
  profiles: readonly TableProfile[],
  options: DisclosureOptions = {},
): DisclosurePayload {
  const truncations: Truncation[] = [];
  const ordered = [...profiles].sort((a, b) => a.sheetIndex - b.sheetIndex);
  const payload: DisclosurePayload = {
    version: 1,
    file: {
      name: displayName(upload.originalFilename),
      format: upload.format,
      byteSize: upload.byteSize,
      sha256: upload.sha256,
      encoding: upload.encoding === null ? null : upload.encoding.slice(0, 32),
    },
    tables: ordered.map((profile) => discloseTable(profile, truncations)),
    truncations,
  };
  const maxBytes = options.maxBytes ?? DISCLOSURE_MAX_BYTES;
  const ladder = new Ladder(payload, maxBytes);
  const settled = ladder.fits() || ladder.dropTopValues() || ladder.reduceSampleRows() || ladder.dropSampleRows() || ladder.truncateColumns();
  if (!settled) ladder.omitTables();
  return enforceCeiling(ladder.materialize(), maxBytes);
}
