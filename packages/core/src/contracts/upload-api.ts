// ---------------------------------------------------------------------------
// Upload, profile, and disclosure-payload contracts (FEAT-104 TASK-001).
//
// Module invariant: `packages/core` is imported by the browser, so this file
// may not import Node built-ins. Every field here crosses an HTTP boundary
// now and, for the disclosure payload, a prompt later — so every field must
// survive a JSON round trip unchanged: no `Date`, no `undefined`, no `NaN`,
// no `Infinity`, no `Map`.
//
// Path rule: the only path an upload response carries is `filePath`, relative
// to the data root. No schema here has a field capable of holding an absolute
// path; a test asserts that over the schema's property list.
// ---------------------------------------------------------------------------

import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { SAMPLE_CELL_MAX_CHARS, SAMPLE_ROW_COUNT, TOP_VALUES_COUNT, UPLOAD_LIMIT_DEFAULTS } from '../ingestion/limits';

const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const Count = Type.Integer({ minimum: 0 });

/** File formats the application reads. Detected from content, never from the extension. */
export const FILE_FORMATS = ['csv', 'xlsx'] as const;
export const FileFormatSchema = Type.Union(FILE_FORMATS.map((format) => Type.Literal(format)));

/** Column types the profiler can infer. `empty` means every cell was null or blank. */
export const INFERRED_TYPES = ['integer', 'decimal', 'boolean', 'date', 'datetime', 'string', 'empty'] as const;
export const InferredTypeSchema = Type.Union(INFERRED_TYPES.map((type) => Type.Literal(type)));

/** Lifecycle of an upload's profile. */
export const PROFILE_STATUSES = ['pending', 'profiling', 'profiled', 'failed'] as const;
export const ProfileStatusSchema = Type.Union(PROFILE_STATUSES.map((status) => Type.Literal(status)));

/**
 * Structured findings a profile records instead of silently resolving (D06).
 *
 * FEAT-105 turns these into questions or disclosed defaults. Each is a code,
 * never prose, so the wording can live in the interface.
 */
export const PROFILE_NOTE_CODES = [
  'ambiguous_date_format',
  'mixed_type_column',
  'duplicate_headers_renamed',
  'no_header_detected',
  'row_cap_reached',
  'leading_blank_rows_skipped',
  'ragged_rows',
  'blank_rows',
  'encoding_guessed',
  'hidden_sheet',
  'empty_sheet',
  'sheet_cap_reached',
  'merged_cells',
  'formula_cells',
] as const;
export const ProfileNoteCodeSchema = Type.Union(PROFILE_NOTE_CODES.map((code) => Type.Literal(code)));

/** One structured finding. Carries names, counts, and formats — never a cell value. */
export const ProfileNoteSchema = Type.Object({
  code: ProfileNoteCodeSchema,
  /** The column a per-column note is about. */
  column: Type.Optional(Type.String({ maxLength: SAMPLE_CELL_MAX_CHARS })),
  /** Columns a table-level note names, such as the renamed duplicates. */
  columns: Type.Optional(Type.Array(Type.String({ maxLength: SAMPLE_CELL_MAX_CHARS }), { maxItems: 20 })),
  /** How many rows, cells, or sheets the finding covers. */
  count: Type.Optional(Count),
  /** The limit that was reached, for cap notes. */
  limit: Type.Optional(Count),
  /** Candidate formats or encodings, for ambiguity and guess notes. */
  formats: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 4 })),
});

/** Statistics for integer and decimal columns. Percentiles come from a seeded reservoir. */
export const NumericStatsSchema = Type.Object({
  kind: Type.Literal('numeric'),
  min: Type.Number(),
  max: Type.Number(),
  mean: Type.Number(),
  /** Sample standard deviation; null with fewer than two values. */
  stddev: Nullable(Type.Number()),
  median: Type.Number(),
  p25: Type.Number(),
  p75: Type.Number(),
  /** True when the column had more numeric values than the reservoir holds. */
  approximate: Type.Boolean(),
});

/** Statistics for date and datetime columns. Bounds are ISO-8601 strings. */
export const TemporalStatsSchema = Type.Object({
  kind: Type.Literal('temporal'),
  min: Type.String(),
  max: Type.String(),
  /** The pattern that explains the values, e.g. `DD/MM/YYYY`, or `excel-native` for typed workbook cells. */
  detectedFormat: Type.String({ maxLength: 64 }),
  /** True when a second pattern explains exactly the same values (day/month versus month/day). */
  ambiguous: Type.Boolean(),
  /** The other pattern when `ambiguous` is true. */
  alternateFormat: Nullable(Type.String({ maxLength: 64 })),
});

/** Length statistics for text columns, in characters. */
export const StringStatsSchema = Type.Object({
  kind: Type.Literal('string'),
  minLength: Count,
  maxLength: Count,
  meanLength: Type.Number({ minimum: 0 }),
});

export const ColumnStatsSchema = Type.Union([NumericStatsSchema, TemporalStatsSchema, StringStatsSchema]);

/** One frequent value. The value is at most one sample cell long. */
export const TopValueSchema = Type.Object({
  value: Type.String({ maxLength: SAMPLE_CELL_MAX_CHARS }),
  count: Type.Integer({ minimum: 1 }),
});

/** One profiled column. `isHighCardinality` implies `distinctCount` and `topValues` are null. */
export const ColumnProfileSchema = Type.Object({
  position: Count,
  name: Type.String(),
  originalName: Nullable(Type.String()),
  inferredType: InferredTypeSchema,
  typeConfidence: Type.Number({ minimum: 0, maximum: 1 }),
  isMixedType: Type.Boolean(),
  nullCount: Count,
  blankCount: Count,
  valueCount: Count,
  distinctCount: Nullable(Count),
  isHighCardinality: Type.Boolean(),
  stats: Nullable(ColumnStatsSchema),
  topValues: Nullable(Type.Array(TopValueSchema, { maxItems: TOP_VALUES_COUNT })),
});

/** What the CSV dialect sniffer decided, with its confidence in each choice. */
export const CsvDialectSchema = Type.Object({
  quoteChar: Type.String({ minLength: 1, maxLength: 1 }),
  lineEnding: Type.Union([Type.Literal('\r\n'), Type.Literal('\n'), Type.Literal('\r')]),
  hasBom: Type.Boolean(),
  confidence: Type.Object({
    delimiter: Type.Number({ minimum: 0, maximum: 1 }),
    quoteChar: Type.Number({ minimum: 0, maximum: 1 }),
    lineEnding: Type.Number({ minimum: 0, maximum: 1 }),
    header: Type.Number({ minimum: 0, maximum: 1 }),
  }),
});

const SampleCellSchema = Type.String({ maxLength: SAMPLE_CELL_MAX_CHARS });
const SampleRowsSchema = Type.Array(Type.Array(SampleCellSchema), { maxItems: SAMPLE_ROW_COUNT });

/** One profiled table: the whole of a CSV, or one worksheet of a workbook. */
export const TableProfileSchema = Type.Object({
  sheetName: Nullable(Type.String()),
  sheetIndex: Count,
  isHidden: Type.Boolean(),
  rowCount: Count,
  /** False when the row scan limit stopped the count; `rowCount` is then a lower bound. */
  rowCountExact: Type.Boolean(),
  columnCount: Count,
  hasHeader: Type.Boolean(),
  headerRowIndex: Nullable(Count),
  delimiter: Nullable(Type.String({ minLength: 1, maxLength: 1 })),
  dialect: Nullable(CsvDialectSchema),
  raggedRowCount: Count,
  blankRowCount: Count,
  mergedCellCount: Count,
  formulaCellCount: Count,
  sampleRows: SampleRowsSchema,
  notes: Type.Array(ProfileNoteSchema),
  columns: Type.Array(ColumnProfileSchema),
});

/** A column as it appears in the disclosure payload. */
export const DisclosedColumnSchema = Type.Object({
  position: Count,
  name: Type.String({ maxLength: SAMPLE_CELL_MAX_CHARS }),
  originalName: Nullable(Type.String({ maxLength: SAMPLE_CELL_MAX_CHARS })),
  inferredType: InferredTypeSchema,
  typeConfidence: Type.Number({ minimum: 0, maximum: 1 }),
  isMixedType: Type.Boolean(),
  nullCount: Count,
  blankCount: Count,
  distinctCount: Nullable(Count),
  isHighCardinality: Type.Boolean(),
  stats: Nullable(ColumnStatsSchema),
  topValues: Nullable(Type.Array(TopValueSchema, { maxItems: TOP_VALUES_COUNT })),
});

/** A table as it appears in the disclosure payload. */
export const DisclosedTableSchema = Type.Object({
  sheetName: Nullable(Type.String({ maxLength: SAMPLE_CELL_MAX_CHARS })),
  sheetIndex: Count,
  isHidden: Type.Boolean(),
  rowCount: Count,
  rowCountExact: Type.Boolean(),
  columnCount: Count,
  hasHeader: Type.Boolean(),
  delimiter: Nullable(Type.String({ minLength: 1, maxLength: 1 })),
  columns: Type.Array(DisclosedColumnSchema),
  /** Columns left out by the degradation ladder's last step. */
  omittedColumnCount: Count,
  sampleRows: SampleRowsSchema,
  notes: Type.Array(ProfileNoteSchema),
});

/** Steps of the fixed degradation ladder, in the order they are applied. */
export const TRUNCATION_STEPS = [
  'limit_notes',
  'drop_top_values',
  'reduce_sample_rows',
  'drop_sample_rows',
  'truncate_columns',
  'omit_tables',
] as const;

/** One recorded degradation step, so a person can be told exactly what was left out. */
export const TruncationSchema = Type.Object({
  step: Type.Union(TRUNCATION_STEPS.map((step) => Type.Literal(step))),
  /** The table the step applied to, when it applied to one. */
  sheetIndex: Type.Optional(Count),
  /** What was kept: sample rows per table, or columns per table. */
  kept: Type.Optional(Count),
  /** What was left out: notes, columns, or tables. */
  omitted: Type.Optional(Count),
});

/**
 * The complete set of user data the application is permitted to transmit.
 *
 * The caps here (10 sample rows, 200-character cells, 5 frequent values) are
 * schema-enforced as well as builder-enforced; the 64 KiB byte ceiling is
 * enforced by the builder, which is the only thing that can measure it.
 */
export const DisclosurePayloadSchema = Type.Object({
  version: Type.Literal(1),
  file: Type.Object({
    name: Type.String({ maxLength: 255 }),
    format: FileFormatSchema,
    byteSize: Count,
    sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    encoding: Nullable(Type.String({ maxLength: 32 })),
  }),
  tables: Type.Array(DisclosedTableSchema),
  truncations: Type.Array(TruncationSchema),
});

/** A relative path under the data root; a drive letter, leading slash, or `..` segment is rejected. */
const RelativePathSchema = Type.String({
  minLength: 1,
  pattern: '^(?![A-Za-z]:)(?![\\\\/])(?!.*(?:^|[\\\\/])\\.\\.(?:[\\\\/]|$)).+$',
});

/** One stored upload as the API describes it. */
export const UploadSchema = Type.Object({
  id: Type.Integer({ minimum: 1 }),
  taskId: Nullable(Type.Integer({ minimum: 1 })),
  originalFilename: Type.String(),
  storedFilename: Type.String(),
  /** Relative to the data root only. There is deliberately no absolute-path field. */
  filePath: RelativePathSchema,
  format: FileFormatSchema,
  mimeType: Type.String(),
  byteSize: Count,
  sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  encoding: Nullable(Type.String()),
  profileStatus: ProfileStatusSchema,
  profileError: Nullable(Type.Object({ code: Type.String(), message: Type.String() })),
  profileDurationMs: Nullable(Count),
  stagedAt: Type.String(),
  attachedAt: Nullable(Type.String()),
  createdAt: Type.String(),
});

/** `POST /api/uploads` and `GET /api/uploads/:id`: an upload, its tables, and its disclosure payload. */
export const UploadResponseSchema = Type.Object({
  upload: UploadSchema,
  profiles: Type.Array(TableProfileSchema),
  disclosure: Nullable(DisclosurePayloadSchema),
});

/** `GET /api/tasks/:taskId/uploads`: unpaginated, because a task holds at most a handful of files. */
export const UploadListResponseSchema = Type.Object({
  uploads: Type.Array(UploadResponseSchema, { maxItems: UPLOAD_LIMIT_DEFAULTS.maxFilesPerTask }),
});

/** `DELETE /api/uploads/:id`. */
export const DeleteUploadResponseSchema = Type.Object({ id: Type.Integer({ minimum: 1 }), deleted: Type.Literal(true) });

export type FileFormat = (typeof FILE_FORMATS)[number];
export type InferredType = (typeof INFERRED_TYPES)[number];
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];
export type ProfileNoteCode = (typeof PROFILE_NOTE_CODES)[number];
export type TruncationStep = (typeof TRUNCATION_STEPS)[number];
export type ProfileNote = Static<typeof ProfileNoteSchema>;
export type NumericStats = Static<typeof NumericStatsSchema>;
export type TemporalStats = Static<typeof TemporalStatsSchema>;
export type StringStats = Static<typeof StringStatsSchema>;
export type ColumnStats = Static<typeof ColumnStatsSchema>;
export type TopValue = Static<typeof TopValueSchema>;
export type ColumnProfile = Static<typeof ColumnProfileSchema>;
export type CsvDialectInfo = Static<typeof CsvDialectSchema>;
export type TableProfile = Static<typeof TableProfileSchema>;
export type DisclosedColumn = Static<typeof DisclosedColumnSchema>;
export type DisclosedTable = Static<typeof DisclosedTableSchema>;
export type Truncation = Static<typeof TruncationSchema>;
export type DisclosurePayload = Static<typeof DisclosurePayloadSchema>;
export type Upload = Static<typeof UploadSchema>;
export type UploadResponse = Static<typeof UploadResponseSchema>;
export type UploadListResponse = Static<typeof UploadListResponseSchema>;
export type DeleteUploadResponse = Static<typeof DeleteUploadResponseSchema>;
