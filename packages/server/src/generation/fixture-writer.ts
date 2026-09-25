// Serialization of synthetic fixture tables (FEAT-106 TASK-005). A fixture
// must meet a script in the same shape the real file will: the same format,
// the same CSV dialect and encoding, the same sheet names and order, and
// typed workbook cells where the profile saw typed cells.

import { readFileSync, writeFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { parseNumber, type SyntheticSource, type SyntheticTable } from '@automate/core';

/** One built table plus the facts needed to write it the way the real file is written. */
export interface FixtureSheet {
  readonly sheetName: string | null;
  readonly isHidden: boolean;
  readonly hasHeader: boolean;
  readonly source: SyntheticSource;
  readonly table: SyntheticTable;
}
export interface CsvDialectFacts { readonly delimiter: string; readonly quoteChar: string; readonly lineEnding: string; readonly hasBom: boolean }

// Windows-1252 bytes 0x80–0x9F, which differ from Latin-1.
const CP1252 = new Map<string, number>(['€', '', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '', 'Ž', '', '', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '', 'ž', 'Ÿ'].flatMap((char, index) => (char ? [[char, 0x80 + index] as [string, number]] : [])));

/** Encode text the way the real file was encoded, so a script that names the encoding reads the fixture too. */
export function encodeText(text: string, encoding: string | null, hasBom: boolean): Buffer {
  if (encoding === 'utf-16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  if (encoding === 'utf-16be') return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]);
  if (encoding === 'windows-1252') return Buffer.from([...text].map((char) => { const code = char.codePointAt(0)!; return CP1252.get(char) ?? (code <= 0xff && (code < 0x80 || code > 0x9f) ? code : 0x3f); }));
  const body = Buffer.from(text, 'utf8');
  return hasBom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}

/** Quote a field when the dialect requires it, doubling embedded quote characters. */
function csvField(value: string, dialect: CsvDialectFacts): string {
  const needsQuotes = value.includes(dialect.delimiter) || value.includes(dialect.quoteChar) || /[\r\n]/.test(value) || /^\s|\s$/.test(value);
  return needsQuotes ? `${dialect.quoteChar}${value.split(dialect.quoteChar).join(dialect.quoteChar.repeat(2))}${dialect.quoteChar}` : value;
}

/**
 * Serialize one table as CSV in the real file's dialect.
 *
 * @param sheet The built table; its header row is written only when the real file has one.
 * @param dialect Delimiter, quote character, line ending, and BOM of the real file.
 * @returns The CSV text, ending with a line ending.
 */
export function renderCsv(sheet: FixtureSheet, dialect: CsvDialectFacts): string {
  const rows = sheet.hasHeader ? [sheet.table.header, ...sheet.table.rows] : sheet.table.rows;
  return rows.map((row) => row.map((cell) => csvField(cell, dialect)).join(dialect.delimiter) + dialect.lineEnding).join('');
}

/** Write CSV bytes. @returns The bytes written, for digesting. */
export function writeCsv(file: string, sheet: FixtureSheet, dialect: CsvDialectFacts, encoding: string | null): Buffer {
  const bytes = encodeText(renderCsv(sheet, dialect), encoding, dialect.hasBom);
  writeFileSync(file, bytes);
  return bytes;
}

/** Turn a fixture cell into the typed value a workbook would hold for this column. */
export function typedCell(cell: string, column: SyntheticSource['columns'][number] | undefined): string | number | boolean | Date | null {
  if (cell === '') return null;
  const type = column?.inferredType;
  if (type === 'integer' || type === 'decimal') return parseNumber(cell.trim())?.value ?? cell;
  if (type === 'boolean' && /^(?:true|false)$/i.test(cell.trim())) return /^true$/i.test(cell.trim());
  const native = column?.stats?.kind === 'temporal' && column.stats.detectedFormat === 'excel-native';
  if (native && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z?)?$/.test(cell)) return new Date(cell.length === 10 ? `${cell}T00:00:00Z` : cell.endsWith('Z') ? cell : `${cell}Z`);
  return cell;
}

type StreamingSheet = { addRow(values: unknown[]): { commit(): void }; commit(): Promise<void> | void };

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;

/**
 * Zero every entry's DOS modification time in a zip, in place (FEAT-107).
 *
 * exceljs stamps each zip entry with the moment it was written, so the same
 * workbook written twice is two different byte strings. FEAT-107 re-derives a
 * fixture and compares its SHA-256 with the recorded one; with timestamps in
 * the bytes, every XLSX fixture would fail that check. After this, the bytes
 * depend on the content only. Entries are left intact otherwise.
 *
 * @param zip The complete archive.
 * @returns The same buffer; unchanged when it is not a well-formed zip.
 */
export function normalizeZipTimestamps(zip: Buffer): Buffer {
  let end = -1;
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 65_557); offset -= 1) {
    if (zip.readUInt32LE(offset) === END_OF_CENTRAL) { end = offset; break; }
  }
  if (end < 0) return zip;
  const entries = zip.readUInt16LE(end + 10);
  let cursor = zip.readUInt32LE(end + 16);
  for (let index = 0; index < entries && cursor + 46 <= zip.length; index += 1) {
    if (zip.readUInt32LE(cursor) !== CENTRAL_HEADER) return zip;
    zip.writeUInt32LE(0x00210000, cursor + 12); // time 00:00:00, date 1980-01-01
    const local = zip.readUInt32LE(cursor + 42);
    if (local + 30 <= zip.length && zip.readUInt32LE(local) === LOCAL_HEADER) zip.writeUInt32LE(0x00210000, local + 10);
    cursor += 46 + zip.readUInt16LE(cursor + 28) + zip.readUInt16LE(cursor + 30) + zip.readUInt16LE(cursor + 32);
  }
  return zip;
}

/**
 * Write every sheet into one workbook with exceljs's STREAMING writer only
 * (memory's rule: never build a whole workbook in memory).
 *
 * @param file Destination path, already resolved inside the fixtures directory.
 * @param sheets Sheets in the real workbook's order.
 */
export async function writeXlsx(file: string, sheets: readonly FixtureSheet[]): Promise<void> {
  const writer = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: file, useStyles: false, useSharedStrings: false });
  writer.created = new Date(0);
  writer.modified = new Date(0);
  for (const [index, sheet] of sheets.entries()) {
    const worksheet = writer.addWorksheet(sheet.sheetName ?? `Sheet${index + 1}`, { state: sheet.isHidden ? 'hidden' : 'visible' }) as unknown as StreamingSheet;
    const columns = [...sheet.source.columns].sort((left, right) => left.position - right.position);
    if (sheet.hasHeader) worksheet.addRow([...sheet.table.header]).commit();
    for (const row of sheet.table.rows) worksheet.addRow(row.map((cell, column) => typedCell(cell, columns[column]))).commit();
    await worksheet.commit();
  }
  await writer.commit();
  // Same content, same bytes: a fixture must be reproducible to be verifiable (FEAT-107).
  writeFileSync(file, normalizeZipTimestamps(readFileSync(file)));
}
