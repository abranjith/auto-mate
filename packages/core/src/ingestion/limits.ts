// ---------------------------------------------------------------------------
// Ingestion limits (FEAT-104).
//
// Module invariant: this file is part of `packages/core`, which the browser
// imports. It may not import Node built-ins, and every value here must be a
// plain JSON-safe number or string.
//
// Two different kinds of number live here, and they must not be confused:
//
// 1. D04 **policy** values. They define what a disclosure payload may contain
//    and therefore what may ever leave the machine. They are not performance
//    knobs; changing one is a privacy decision, made by a person, recorded in
//    the plan. They are deliberately not environment variables.
// 2. D14 **provisional defaults** for resource limits. The server reads each
//    one from an environment variable and falls back to the value here; the
//    browser uses the same value for its client-side pre-checks so the two
//    never disagree about the default.
// ---------------------------------------------------------------------------

/** D04: how many data rows (after the header) a profile keeps as samples. */
export const SAMPLE_ROW_COUNT = 10;

/** D04: the longest a sampled cell may be, in UTF-16 code units, including the truncation marker. */
export const SAMPLE_CELL_MAX_CHARS = 200;

/** D04: the hard ceiling on a serialized disclosure payload, in UTF-8 bytes (64 KiB). */
export const DISCLOSURE_MAX_BYTES = 65_536;

/**
 * D04: a column stops tracking values once it holds this many distinct ones.
 *
 * At that point the column is high-cardinality: it reports no distinct count
 * and no frequent values, ever. The same cap bounds the accumulator's memory,
 * so the privacy rule and the memory rule are one mechanism.
 */
export const CARDINALITY_TRACKING_CAP = 1_000;

/** D04: how many frequent values a low-cardinality column may disclose. */
export const TOP_VALUES_COUNT = 5;

/**
 * D04: the size of the seeded numeric reservoir used for median and quartiles.
 *
 * Up to this many numeric values the percentiles are exact; beyond it they are
 * estimated from a deterministic sample and flagged `approximate`.
 */
export const NUMERIC_RESERVOIR_SIZE = 10_000;

/**
 * D04: the longest value a column will track for frequent-value counting.
 *
 * A value longer than a sample cell is free text. Tracking it would let one
 * column hold `CARDINALITY_TRACKING_CAP` arbitrarily long strings, so a column
 * containing one is treated as high-cardinality and discloses no values.
 */
export const TRACKED_VALUE_MAX_CHARS = SAMPLE_CELL_MAX_CHARS;

/** The marker appended to a truncated sample cell. One code unit, so the cap stays exact. */
export const TRUNCATION_MARKER = '…';

/** How many bytes of a file the format, encoding, and dialect detectors look at (64 KiB). */
export const PROBE_BYTES = 65_536;

/** How many leading rows the XLSX header scan inspects before giving up on a header. */
export const HEADER_SCAN_ROWS = 10;

/** Upload size defaults that the server may override from its environment (D14, provisional). */
export const UPLOAD_LIMIT_DEFAULTS = {
  /** `AUTOMATE_MAX_UPLOAD_BYTES`: 50 MB per file. */
  maxUploadBytes: 50 * 1024 * 1024,
  /** `AUTOMATE_MAX_FILES_PER_TASK`: 5 files per task. Also the request schema's hard ceiling. */
  maxFilesPerTask: 5,
  /** `AUTOMATE_MAX_PROFILE_ROWS`: rows scanned per table before the count is reported as a lower bound. */
  maxProfileRows: 1_000_000,
  /** `AUTOMATE_MAX_COLUMNS`: columns profiled per table. */
  maxColumns: 512,
  /** `AUTOMATE_PARSE_TIMEOUT_MS`: wall-clock limit on reading and profiling one file. */
  parseTimeoutMs: 60_000,
  /** `AUTOMATE_MAX_SHEETS`: worksheets profiled per workbook. */
  maxSheets: 20,
  /** `AUTOMATE_MAX_INFLATED_BYTES`: how much a workbook may expand to when unzipped (1 GB). */
  maxInflatedBytes: 1024 * 1024 * 1024,
  /** `AUTOMATE_STAGED_UPLOAD_TTL_HOURS`: how long an upload may wait unattached before it is swept. */
  stagedUploadTtlHours: 24,
} as const;

/** The file extensions the file picker offers. Content, not extension, decides the format. */
export const ACCEPTED_UPLOAD_EXTENSIONS = ['.csv', '.tsv', '.xlsx'] as const;
