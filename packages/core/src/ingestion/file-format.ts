// ---------------------------------------------------------------------------
// File-format detection (FEAT-104 TASK-002).
//
// Module invariant: pure and synchronous over a byte buffer; no Node
// built-ins.
//
// Format is decided by CONTENT. A workbook saved with a `.csv` name is common
// and must not be routed to the CSV parser. The extension and the browser's
// MIME type are recorded by the caller and consulted here only as a tie-break
// when the content alone cannot settle it.
// ---------------------------------------------------------------------------

import type { FileFormat } from '../contracts/upload-api';
import { EmptyFileError, UnsupportedFileFormatError } from '../errors/ingestion-errors';
import { detectBom } from './encoding';

/** What the client said about the file. Never the deciding signal. */
export interface FormatHints {
  readonly filename?: string | null;
  readonly mimeType?: string | null;
}

const ZIP_LOCAL_HEADER = [0x50, 0x4b, 0x03, 0x04];
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
/**
 * Signatures of common binary formats that would otherwise need the
 * control-character test. Executables (`MZ`) are not listed: two printable
 * letters could begin a real header, and executables fail the NUL test anyway.
 */
const BINARY_SIGNATURES: readonly (readonly number[])[] = [
  [0x25, 0x50, 0x44, 0x46, 0x2d], // %PDF-
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF8
  [0x1f, 0x8b], // gzip
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0x37, 0x7a, 0xbc, 0xaf], // 7z
  [0x52, 0x61, 0x72, 0x21], // Rar!
];
const NON_WORKBOOK_OLE2_EXTENSIONS = new Set(['.doc', '.ppt', '.msg', '.pub', '.vsd']);

const startsWith = (bytes: Uint8Array, signature: readonly number[]) =>
  bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);

/**
 * Lower-cased extension of a client-supplied filename, including the dot.
 *
 * @param filename A display name; never a path this application uses.
 * @returns For example `.xlsx`, or null when there is none.
 */
export function extensionOf(filename: string | null | undefined): string | null {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(filename ?? '');
  return match ? `.${match[1]!.toLowerCase()}` : null;
}

/**
 * Read the entry names of every ZIP local file header found in a buffer.
 *
 * Only the header block's name field is read; compressed data is never
 * interpreted.
 *
 * @param bytes The first bytes of a ZIP archive.
 * @returns Entry names in the order found.
 */
export function zipEntryNames(bytes: Uint8Array): string[] {
  const names: string[] = [];
  for (let offset = 0; offset + 30 <= bytes.length; offset += 1) {
    if (bytes[offset] !== 0x50 || !startsWith(bytes.subarray(offset), ZIP_LOCAL_HEADER)) continue;
    const nameLength = bytes[offset + 26]! | (bytes[offset + 27]! << 8);
    const start = offset + 30;
    if (nameLength === 0 || start + nameLength > bytes.length) continue;
    names.push(String.fromCharCode(...bytes.subarray(start, start + nameLength)));
  }
  return names;
}

function detectZip(bytes: Uint8Array, hints: FormatHints): FileFormat {
  const names = zipEntryNames(bytes);
  if (names.some((name) => name.startsWith('xl/'))) return 'xlsx';
  const otherOffice = names.some((name) => /^(?:word|ppt|visio)\//.test(name));
  if (names.includes('[Content_Types].xml') && !otherOffice) return 'xlsx';
  if (!otherOffice && extensionOf(hints.filename) === '.xlsx') return 'xlsx';
  throw new UnsupportedFileFormatError('other');
}

/** Text is allowed tabs, newlines, carriage returns, form feeds, and the DOS end-of-file mark. */
function looksBinary(bytes: Uint8Array): boolean {
  let control = 0;
  for (const byte of bytes) {
    if (byte === 0) return true;
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c && byte !== 0x1a) control += 1;
  }
  return control > bytes.length * 0.01;
}

/**
 * Decide a file's format from its first bytes.
 *
 * - A ZIP whose entries are OOXML spreadsheet parts is `xlsx`.
 * - The legacy OLE2 signature is the old `.xls` format and is refused with
 *   guidance to re-save as `.xlsx`.
 * - Anything else that looks like text is `csv` (any delimiter).
 * - Everything else is refused.
 *
 * @param header The first bytes of the file (the application uses 64 KiB).
 * @param hints The client's filename and MIME type, used only as a tie-break.
 * @returns The detected format.
 * @throws EmptyFileError for an empty file or one holding only a byte-order mark.
 * @throws UnsupportedFileFormatError for `.xls` and non-tabular files.
 * @example detectFileFormat(new TextEncoder().encode('a,b\n1,2')) // 'csv'
 */
export function detectFileFormat(header: Uint8Array, hints: FormatHints = {}): FileFormat {
  const bom = detectBom(header);
  if (header.length === 0 || (bom !== null && header.length === bom.length)) throw new EmptyFileError();
  if (startsWith(header, ZIP_LOCAL_HEADER)) return detectZip(header, hints);
  if (startsWith(header, OLE2)) {
    const extension = extensionOf(hints.filename);
    throw new UnsupportedFileFormatError(extension !== null && NON_WORKBOOK_OLE2_EXTENSIONS.has(extension) ? 'other' : 'xls');
  }
  if (bom) return 'csv';
  if (BINARY_SIGNATURES.some((signature) => startsWith(header, signature)) || looksBinary(header)) {
    throw new UnsupportedFileFormatError('other');
  }
  return 'csv';
}
