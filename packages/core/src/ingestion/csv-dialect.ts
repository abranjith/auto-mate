// ---------------------------------------------------------------------------
// Delimited-text dialect sniffing (FEAT-104 TASK-002).
//
// Module invariant: pure and synchronous over a decoded string; no Node
// built-ins, no parser library. The server's streaming parser is configured
// from what this returns; this module never reads a file.
//
// Every choice is reported with a confidence. Delimiter and header choices are
// cosmetic under D06 — they are decided, and the confidence makes the decision
// visible rather than silent.
// ---------------------------------------------------------------------------

import { isBlankRow, isHeaderRow, resolveColumnNames } from './header-detection';

/** Delimiters sniffed, in tie-break preference order. */
export const CSV_DELIMITERS = [',', ';', '\t', '|'] as const;
export type CsvDelimiter = (typeof CSV_DELIMITERS)[number];
export type CsvQuote = '"' | "'";
export type CsvLineEnding = '\r\n' | '\n' | '\r';

/** Everything the sniffer decided about one delimited file. */
export interface CsvDialect {
  readonly delimiter: CsvDelimiter;
  readonly quoteChar: CsvQuote;
  readonly lineEnding: CsvLineEnding;
  readonly hasHeader: boolean;
  /** The most common field count: the table's width. */
  readonly columnCount: number;
  /** Header text deduplicated, or `column_1…column_n` when there is no header. */
  readonly columnNames: readonly string[];
  readonly confidence: {
    readonly delimiter: number;
    readonly quoteChar: number;
    readonly lineEnding: number;
    readonly header: number;
  };
}

/** How many records of the probe the sniffer inspects per candidate delimiter. */
const SNIFF_RECORDS = 1_000;
/** How many rows under row 0 the header test inspects. */
const HEADER_EVIDENCE_ROWS = 50;

/**
 * Split delimited text into records, honouring quotes.
 *
 * Handles quoted fields containing the delimiter, embedded newlines, and
 * doubled quotes. A quote in the middle of an unquoted field is literal.
 *
 * @param text Decoded text.
 * @param delimiter Field separator.
 * @param quote Quote character.
 * @param limit Maximum records to return.
 * @returns Records, plus whether the last one was cut off by the end of the text (unterminated quote or no final newline).
 * @example splitRecords('a,"b,c"\n', ',', '"', 10).records // [['a', 'b,c']]
 */
export function splitRecords(
  text: string,
  delimiter: string,
  quote: string,
  limit: number,
): { records: string[][]; lastIsPartial: boolean } {
  const records: string[][] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldStart = true;
  let index = 0;
  const endRecord = () => {
    fields.push(field);
    records.push(fields);
    fields = [];
    field = '';
    fieldStart = true;
  };
  while (index < text.length && records.length < limit) {
    const char = text[index]!;
    if (inQuotes) {
      if (char === quote && text[index + 1] === quote) {
        field += quote;
        index += 2;
        continue;
      }
      if (char === quote) inQuotes = false;
      else field += char;
      index += 1;
      continue;
    }
    if (char === quote && fieldStart) {
      inQuotes = true;
      fieldStart = false;
    } else if (char === delimiter) {
      fields.push(field);
      field = '';
      fieldStart = true;
    } else if (char === '\n' || char === '\r') {
      endRecord();
      if (char === '\r' && text[index + 1] === '\n') index += 1;
    } else {
      field += char;
      fieldStart = false;
    }
    index += 1;
  }
  const trailing = index >= text.length && (fields.length > 0 || field !== '' || inQuotes);
  if (trailing && records.length < limit) endRecord();
  return { records, lastIsPartial: trailing };
}

function sniffLineEnding(text: string): { lineEnding: CsvLineEnding; confidence: number } {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  const cr = (text.match(/\r(?!\n)/g) ?? []).length;
  const total = crlf + lf + cr;
  if (total === 0) return { lineEnding: '\n', confidence: 0 };
  const [lineEnding, count] = ([['\r\n', crlf], ['\n', lf], ['\r', cr]] as const).reduce((best, next) => (next[1] > best[1] ? next : best));
  return { lineEnding, confidence: count / total };
}

function sniffQuote(text: string): { quoteChar: CsvQuote; confidence: number } {
  const boundary = (quote: string) =>
    (text.match(new RegExp(`(?:^|[,;\\t|\\r\\n])${quote}|${quote}(?=[,;\\t|\\r\\n]|$)`, 'g')) ?? []).length;
  const double = boundary('"');
  const single = boundary("'");
  if (double === 0 && single === 0) return { quoteChar: '"', confidence: 0.5 };
  if (single > 0 && double === 0) return { quoteChar: "'", confidence: 1 };
  return { quoteChar: '"', confidence: double / (double + single) };
}

function nonBlankRecords(text: string, delimiter: string, quote: string, complete: boolean): string[][] {
  const { records, lastIsPartial } = splitRecords(text, delimiter, quote, SNIFF_RECORDS);
  const usable = !complete && lastIsPartial ? records.slice(0, -1) : records;
  return usable.filter((record) => !isBlankRow(record));
}

/** The most common field count and the share of records that have it. */
function consistency(records: readonly string[][]): { modal: number; share: number } {
  if (records.length === 0) return { modal: 0, share: 0 };
  const counts = new Map<number, number>();
  for (const record of records) counts.set(record.length, (counts.get(record.length) ?? 0) + 1);
  let modal = 0;
  let best = 0;
  for (const [width, count] of counts) {
    if (count > best || (count === best && width > modal)) [modal, best] = [width, count];
  }
  return { modal, share: best / records.length };
}

function sniffDelimiter(text: string, quote: string, complete: boolean): { delimiter: CsvDelimiter; confidence: number; columnCount: number } {
  let chosen: { delimiter: CsvDelimiter; share: number; modal: number } | null = null;
  for (const delimiter of CSV_DELIMITERS) {
    const { modal, share } = consistency(nonBlankRecords(text, delimiter, quote, complete));
    if (modal > 1 && (chosen === null || share > chosen.share)) chosen = { delimiter, share, modal };
  }
  if (chosen === null) return { delimiter: ',', confidence: 0, columnCount: 1 };
  return { delimiter: chosen.delimiter, confidence: chosen.share, columnCount: chosen.modal };
}

/**
 * Sniff the dialect of a delimited file from a decoded probe.
 *
 * The delimiter is the candidate (comma, semicolon, tab, pipe) whose parse
 * gives the most consistent field count above one, ties going to the earlier
 * candidate. A file where no candidate splits lines is a one-column table,
 * not a table with a spurious delimiter.
 *
 * @param text The start of the file, decoded and without a byte-order mark.
 * @param complete Whether the text is the whole file (otherwise its last record may be cut off).
 * @returns The dialect and a confidence for each choice.
 * @example sniffCsvDialect('id;amount\n1;3,50\n', true).delimiter // ';'
 */
export function sniffCsvDialect(text: string, complete = false): CsvDialect {
  const lineEnding = sniffLineEnding(text);
  const quote = sniffQuote(text);
  const delimiter = sniffDelimiter(text, quote.quoteChar, complete);
  const records = nonBlankRecords(text, delimiter.delimiter, quote.quoteChar, complete);
  const [first, ...rest] = records;
  const header = first ? isHeaderRow(first, rest.slice(0, HEADER_EVIDENCE_ROWS)) : { isHeader: false, confidence: 0 };
  const columnCount = Math.max(delimiter.columnCount, header.isHeader && first ? first.length : 0);
  const { names } = resolveColumnNames(header.isHeader && first ? first : null, columnCount);
  return {
    delimiter: delimiter.delimiter,
    quoteChar: quote.quoteChar,
    lineEnding: lineEnding.lineEnding,
    hasHeader: header.isHeader,
    columnCount,
    columnNames: names.map(({ name }) => name),
    confidence: {
      delimiter: delimiter.confidence,
      quoteChar: quote.confidence,
      lineEnding: lineEnding.confidence,
      header: header.confidence,
    },
  };
}
