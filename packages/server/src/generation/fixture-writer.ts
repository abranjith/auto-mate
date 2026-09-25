// Serialization of synthetic fixture tables (FEAT-106 TASK-005). A fixture
// must meet a script in the same shape the real file will: the same format,
// the same CSV dialect and encoding, the same sheet names and order, and
// typed workbook cells where the profile saw typed cells.

import { writeFileSync } from 'node:fs';
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
}
