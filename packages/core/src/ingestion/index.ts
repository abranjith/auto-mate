// Ingestion barrel (FEAT-104). Pure, browser-safe logic only: no Node built-ins,
// no streams, no I/O. The server feeds these functions buffers and row
// iterators; nothing here opens a file.
export {
  SAMPLE_ROW_COUNT,
  SAMPLE_CELL_MAX_CHARS,
  DISCLOSURE_MAX_BYTES,
  CARDINALITY_TRACKING_CAP,
  TOP_VALUES_COUNT,
  NUMERIC_RESERVOIR_SIZE,
  TRACKED_VALUE_MAX_CHARS,
  TRUNCATION_MARKER,
  PROBE_BYTES,
  HEADER_SCAN_ROWS,
  UPLOAD_LIMIT_DEFAULTS,
  ACCEPTED_UPLOAD_EXTENSIONS,
} from './limits';
export { detectFileFormat, extensionOf, zipEntryNames } from './file-format';
export type { FormatHints } from './file-format';
export { detectEncoding, detectBom, decodeProbe, isValidUtf8 } from './encoding';
export type { EncodingDetection, TextEncodingName } from './encoding';
export { sniffCsvDialect, splitRecords, CSV_DELIMITERS } from './csv-dialect';
export type { CsvDialect, CsvDelimiter, CsvQuote, CsvLineEnding } from './csv-dialect';
export { isHeaderRow, findSheetHeader, resolveColumnNames, isBlankRow } from './header-detection';
export type { ColumnName, HeaderDecision, SheetHeaderScan } from './header-detection';
export {
  classifyCell,
  cellSourceType,
  cellText,
  matchTemporal,
  parseNumber,
  TypeTally,
  TYPE_THRESHOLD,
  TEMPORAL_PATTERNS,
  NATIVE_TEMPORAL_FORMAT,
} from './type-inference';
export type { CellValue, CellKind, CellSourceType, ResolvedType, TemporalReadings } from './type-inference';
export { ColumnAccumulator, percentile } from './column-accumulator';
export type { ColumnSummary, AccumulatorOptions } from './column-accumulator';
export { profileTable, truncateCell } from './table-profiler';
export type { TableSource, SourceFacts, TableMeta, ProfileOptions } from './table-profiler';
export { seededRandom, hash128 } from './seeded-random';
export { buildDisclosurePayload, estimatePayloadBytes, utf8ByteLength, MAX_NOTES_PER_TABLE } from './disclosure-payload';
export type { DisclosureUpload, DisclosureOptions } from './disclosure-payload';
