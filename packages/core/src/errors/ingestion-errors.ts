// ---------------------------------------------------------------------------
// Typed file-ingestion failures (FEAT-104 TASK-001).
//
// The audience cannot read a stack trace. Every limit error therefore names
// the limit AND the actual value, and every parse error names the line or
// sheet where it happened. Parser-library text never appears in a message.
// Messages never contain a filesystem path or a cell value.
// ---------------------------------------------------------------------------

import { AutoMateError } from './automate-error';
import { ERROR_CODES } from './error-codes';

const KIB = 1024;
const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

/**
 * Render a byte count the way a file manager does.
 *
 * @param bytes Non-negative byte count.
 * @returns A short label such as `"78 MB"`, `"12.5 KB"`, or `"512 bytes"`.
 * @example formatBytes(52_428_800) // "50 MB"
 */
export function formatBytes(bytes: number): string {
  const trim = (value: number) => value.toFixed(1).replace(/\.0$/, '');
  if (bytes >= GIB) return `${trim(bytes / GIB)} GB`;
  if (bytes >= MIB) return `${trim(bytes / MIB)} MB`;
  if (bytes >= KIB) return `${trim(bytes / KIB)} KB`;
  return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
}

/**
 * Render two byte counts so that the larger never reads the same as the smaller.
 *
 * `50.0001 MB` and `50 MB` both round to "50 MB", which would tell a person
 * their file equals the limit it exceeded. In that case both fall back to exact
 * byte counts.
 */
function distinctSizes(actual: number, limit: number): [string, string] {
  const [a, l] = [formatBytes(actual), formatBytes(limit)];
  if (a !== l) return [a, l];
  const exact = (value: number) => `${value.toLocaleString('en-US')} bytes`;
  return [exact(actual), exact(limit)];
}

/**
 * The message shown when a file exceeds the upload size limit.
 *
 * Shared by the server error and the browser's pre-check so the two can never
 * disagree about the wording.
 *
 * @param actualBytes The file's size, or a lower bound when `exact` is false.
 * @param limitBytes The configured limit.
 * @param exact Whether `actualBytes` is the real size or only "at least".
 * @returns A plain-English sentence naming both numbers.
 * @example uploadTooLargeMessage(81_788_928, 52_428_800) // "This file is 78 MB. The current limit is 50 MB."
 */
export function uploadTooLargeMessage(
  actualBytes: number,
  limitBytes: number,
  exact = true,
): string {
  if (!exact) {
    const limit = formatBytes(limitBytes);
    return `This file is larger than ${limit}. The current limit is ${limit}.`;
  }
  const [actual, limit] = distinctSizes(actualBytes, limitBytes);
  return `This file is ${actual}. The current limit is ${limit}.`;
}

/**
 * The message shown when a task already has as many files as it may.
 *
 * @param attempted How many files the person tried to attach.
 * @param limit The configured per-task limit.
 * @returns A plain-English sentence naming both numbers.
 * @example uploadLimitMessage(6, 5) // "A task can have at most 5 files. This one would have 6."
 */
export function uploadLimitMessage(attempted: number, limit: number): string {
  return `A task can have at most ${limit} ${limit === 1 ? 'file' : 'files'}. This one would have ${attempted}.`;
}

/** The message shown for the legacy binary `.xls` format. */
export const XLS_RESAVE_MESSAGE =
  'This is an older Excel file (.xls). Open it in Excel and use Save As to save it as an Excel Workbook (.xlsx), then attach that file.';

/** The message shown for anything that is neither delimited text nor a workbook. */
export const UNSUPPORTED_FORMAT_MESSAGE =
  'This file is not a CSV or Excel workbook. Auto-Mate can read .csv, .tsv, and .xlsx files.';

/** Raised when a requested upload does not exist. */
export class UploadNotFoundError extends AutoMateError {
  /** @param id The upload id that was requested. @example new UploadNotFoundError(7) */
  constructor(id: number) {
    super(ERROR_CODES.UPLOAD_NOT_FOUND, `File ${id} was not found. It may have been removed.`);
  }
}

/** Raised the moment an upload stream passes the configured byte limit. */
export class UploadTooLargeError extends AutoMateError {
  /** @param actualBytes Size, or a lower bound when `exact` is false. @param limitBytes The limit. @param exact Whether the size is known exactly. @example new UploadTooLargeError(81_788_928, 52_428_800) */
  constructor(actualBytes: number, limitBytes: number, exact = true) {
    super(ERROR_CODES.UPLOAD_TOO_LARGE, uploadTooLargeMessage(actualBytes, limitBytes, exact));
  }
}

/** Raised when attaching would give a task more files than the limit allows. */
export class UploadLimitReachedError extends AutoMateError {
  /** @param attempted How many files the task would have. @param limit The per-task limit. @example new UploadLimitReachedError(6, 5) */
  constructor(attempted: number, limit: number) {
    super(ERROR_CODES.UPLOAD_LIMIT_REACHED, uploadLimitMessage(attempted, limit));
  }
}

/** Raised when a file's content is neither delimited text nor an XLSX workbook. */
export class UnsupportedFileFormatError extends AutoMateError {
  /** @param kind `xls` for the legacy binary Excel format (with re-save guidance), `other` otherwise. @example new UnsupportedFileFormatError('xls') */
  constructor(readonly kind: 'xls' | 'other' = 'other') {
    super(
      ERROR_CODES.UNSUPPORTED_FILE_FORMAT,
      kind === 'xls' ? XLS_RESAVE_MESSAGE : UNSUPPORTED_FORMAT_MESSAGE,
    );
  }
}

/** Raised when an upload that already belongs to a task is attached or deleted again. */
export class UploadAlreadyAttachedError extends AutoMateError {
  /** @param id The upload id. @example new UploadAlreadyAttachedError(7) */
  constructor(id: number) {
    super(
      ERROR_CODES.UPLOAD_ALREADY_ATTACHED,
      `File ${id} already belongs to a task. Deleting the task removes its files.`,
    );
  }
}

/** Raised for a zero-byte file, or one containing nothing but a byte-order mark. */
export class EmptyFileError extends AutoMateError {
  /** @example new EmptyFileError() */
  constructor() {
    super(ERROR_CODES.FILE_EMPTY, 'This file is empty. Check that it was saved, then attach it again.');
  }
}

/** Where in a file a parse failure happened. */
export interface ParseLocation {
  /** 1-based line number in a delimited-text file. */
  readonly line?: number;
  /** Worksheet name in a workbook. */
  readonly sheet?: string;
}

function describeLocation(location: ParseLocation | undefined): string {
  if (location?.line !== undefined && location.sheet !== undefined)
    return ` (sheet "${location.sheet}", line ${location.line.toLocaleString('en-US')})`;
  if (location?.line !== undefined) return ` (line ${location.line.toLocaleString('en-US')})`;
  if (location?.sheet !== undefined) return ` (sheet "${location.sheet}")`;
  return '';
}

/** Raised when a file cannot be read as the format it claims to be. */
export class ParseFailedError extends AutoMateError {
  /** @param reason Plain-English reason, written by this application, never a library's text. @param location Line or sheet where it happened. @example new ParseFailedError('A quoted value is never closed.', { line: 4812 }) */
  constructor(
    reason: string,
    readonly location?: ParseLocation,
  ) {
    super(
      ERROR_CODES.PARSE_FAILED,
      `This file could not be read${describeLocation(location)}. ${reason}`,
    );
  }
}

/** Raised when reading and profiling one file outlasts the configured time limit. */
export class ParseTimeoutError extends AutoMateError {
  /** @param limitMs The configured limit in milliseconds. @example new ParseTimeoutError(60_000) */
  constructor(limitMs: number) {
    const seconds = Math.round(limitMs / 100) / 10;
    const limit =
      limitMs < 1000 ? `${limitMs} ${limitMs === 1 ? 'millisecond' : 'milliseconds'}` : `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
    super(
      ERROR_CODES.PARSE_TIMEOUT,
      `Reading this file took longer than ${limit}, the current limit, so it was stopped. Try a smaller file.`,
    );
  }
}

/** Raised when a table is wider than the column limit. */
export class TooManyColumnsError extends AutoMateError {
  /** @param actual Columns found. @param limit The configured limit. @param sheet Worksheet name, when the table is a sheet. @example new TooManyColumnsError(600, 512) */
  constructor(actual: number, limit: number, sheet?: string) {
    const where = sheet === undefined ? 'This table' : `Sheet "${sheet}"`;
    super(
      ERROR_CODES.TOO_MANY_COLUMNS,
      `${where} has ${actual.toLocaleString('en-US')} columns. The current limit is ${limit.toLocaleString('en-US')}.`,
    );
  }
}

/** Raised when a workbook expands past its decompression budget while being read. */
export class WorkbookTooLargeError extends AutoMateError {
  /** @param inflatedBytes Bytes expanded before reading stopped (a lower bound). @param limitBytes The budget that was exceeded. @param part Which budget: the whole workbook or its shared-text table. @example new WorkbookTooLargeError(1_100_000_000, 1_073_741_824) */
  constructor(inflatedBytes: number, limitBytes: number, part: 'workbook' | 'shared-strings' = 'workbook') {
    const [actual, limit] = distinctSizes(inflatedBytes, limitBytes);
    const subject = part === 'workbook' ? 'This workbook expands' : "This workbook's shared text table expands";
    super(
      ERROR_CODES.WORKBOOK_TOO_LARGE,
      `${subject} to more than ${actual} when opened. The current limit is ${limit}.`,
    );
  }
}

/** Raised when a file (or every sheet in a workbook) contains no rows at all. */
export class NoTabularContentError extends AutoMateError {
  /** @param sheet Worksheet name, when one sheet is being described. @example new NoTabularContentError() */
  constructor(sheet?: string) {
    super(
      ERROR_CODES.NO_TABULAR_CONTENT,
      sheet === undefined
        ? 'No table was found in this file. It has no rows with values in them.'
        : `No table was found on sheet "${sheet}".`,
    );
  }
}
