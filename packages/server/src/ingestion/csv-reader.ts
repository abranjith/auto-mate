// ---------------------------------------------------------------------------
// CSV reading pipeline (FEAT-104 TASK-006).
//
// File path in, rows out. This module decodes and splits text; it computes no
// statistics — `profileTable` in @automate/core is the only thing that does,
// so CSV and XLSX feed one identical code path.
//
// Pipeline: a 64 KiB probe decides encoding and dialect (pure core logic),
// then the file streams through a decoder into `csv-parse`. Ragged rows are
// data to count, not parse failures, and blank rows are kept so they can be
// counted. Reading stops — and the stream is destroyed — as soon as the row
// cap is reached; a 50 MB file is never drained for nothing.
// ---------------------------------------------------------------------------

import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Transform, pipeline, type Readable } from 'node:stream';
import { CsvError, parse, type Parser } from 'csv-parse';
import {
  EmptyFileError,
  ParseFailedError,
  PROBE_BYTES,
  decodeProbe,
  detectEncoding,
  isBlankRow,
  sniffCsvDialect,
  type CsvDialect,
  type CsvDialectInfo,
  type EncodingDetection,
  type ProfileNote,
  type TextEncodingName,
} from '@automate/core';

/** Longest record the parser will buffer, in characters: a guard against one unclosed quote swallowing a whole file. */
export const MAX_RECORD_CHARS = 1024 * 1024;

export interface CsvReaderOptions {
  /** Data rows (after the header) to yield before stopping; rows past it set `truncated`. */
  readonly maxRows: number;
  readonly signal?: AbortSignal;
  /** Test seam: how to open the file's byte stream. */
  readonly openStream?: (filePath: string) => Readable;
}

/** An open delimited file: what was detected, the header, and a one-shot row iterator. */
export interface CsvTable {
  readonly encoding: EncodingDetection;
  readonly dialect: CsvDialect;
  /** The dialect as a profile records it. */
  readonly dialectInfo: CsvDialectInfo;
  /** Raw header cells, or null when the file has no header. */
  readonly header: string[] | null;
  /** 0-based line index of the header among non-blank-skipping records, or null. */
  readonly headerRowIndex: number | null;
  readonly leadingRowsSkipped: number;
  /** Findings the reader made, such as a guessed encoding. */
  readonly notes: readonly ProfileNote[];
  /** Data rows. Iterate once; breaking out destroys the underlying stream. */
  readonly rows: AsyncIterable<string[]>;
  /** True once iteration stopped at `maxRows` with more rows remaining. */
  readonly truncated: boolean;
}

interface Probe {
  readonly bytes: Uint8Array;
  readonly complete: boolean;
}

async function readProbe(filePath: string): Promise<Probe> {
  const handle = await open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    if (size === 0) throw new EmptyFileError();
    const buffer = new Uint8Array(Math.min(size, PROBE_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { bytes: buffer.subarray(0, bytesRead), complete: size <= PROBE_BYTES };
  } finally {
    await handle.close();
  }
}

/** Validate the whole file as UTF-8 when the probe could only suggest it. Stops at the first invalid byte. */
async function wholeFileIsUtf8(stream: Readable, signal: AbortSignal | undefined): Promise<boolean> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      decoder.decode(chunk as Uint8Array, { stream: true });
    }
    decoder.decode();
    return true;
  } catch (cause) {
    if (cause instanceof TypeError) return false;
    throw cause;
  } finally {
    stream.destroy();
  }
}

/**
 * Settle the encoding. A probe of pure ASCII (or valid UTF-8) followed by a
 * latin-1 byte half-way through the file is the common Excel-export case, so
 * a partial probe's UTF-8 verdict is confirmed over every byte.
 */
async function settleEncoding(
  probe: Probe,
  filePath: string,
  openStream: (path: string) => Readable,
  signal: AbortSignal | undefined,
): Promise<EncodingDetection> {
  const detected = detectEncoding(probe.bytes, probe.complete);
  if (detected.encoding !== 'utf-8' || detected.bomLength > 0 || probe.complete) return detected;
  return (await wholeFileIsUtf8(openStream(filePath), signal))
    ? { encoding: 'utf-8', confidence: 1, bomLength: 0 }
    : { encoding: 'windows-1252', confidence: 0.5, bomLength: 0 };
}

/** Streaming text decoder for the settled encoding. `TextDecoder` drops a leading BOM itself. */
function decoderFor(encoding: TextEncodingName): Transform {
  const decoder = new TextDecoder(encoding);
  return new Transform({
    readableObjectMode: true,
    transform(chunk: Buffer, _encoding, callback) {
      const text = decoder.decode(chunk, { stream: true });
      callback(null, text === '' ? undefined : text);
    },
    flush(callback) {
      const text = decoder.decode();
      callback(null, text === '' ? undefined : text);
    },
  });
}

/** Translate a parser failure into plain English with a 1-based line number; library text never escapes. */
export function toParseFailure(cause: unknown, recordStartLine: number): unknown {
  if (!(cause instanceof CsvError)) return cause;
  if (cause.code === 'CSV_QUOTE_NOT_CLOSED') {
    return new ParseFailedError('A quoted value starts on this line and is never closed. Look for a stray quotation mark.', { line: recordStartLine });
  }
  if (cause.code === 'CSV_MAX_RECORD_SIZE') {
    return new ParseFailedError('A row starting here is longer than 1 MB, which usually means a quotation mark is never closed.', { line: recordStartLine });
  }
  return new ParseFailedError('The text could not be split into rows and columns here.', { line: recordStartLine });
}

type ParsedRecord = { record: string[]; info: { lines: number } };

function createParser(dialect: CsvDialect): Parser {
  return parse({
    delimiter: dialect.delimiter,
    quote: dialect.quoteChar,
    escape: dialect.quoteChar,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: false,
    bom: true,
    info: true,
    max_record_size: MAX_RECORD_CHARS,
  });
}

/** Pulls parsed records one at a time and remembers where the last one ended, for error line numbers. */
class RecordSource {
  private lastLine = 0;
  private closed = false;
  private readonly iterator: AsyncIterator<unknown>;

  constructor(
    private readonly parser: Parser,
    private readonly source: Readable,
    private readonly detach: () => void,
  ) {
    this.iterator = parser[Symbol.asyncIterator]();
  }

  /** The next record, or null at the end of the file. @throws ParseFailedError with the line the failing record starts on. */
  async next(): Promise<string[] | null> {
    try {
      const result = await this.iterator.next();
      if (result.done) return null;
      const parsed = result.value as ParsedRecord;
      this.lastLine = parsed.info.lines;
      return parsed.record;
    } catch (cause) {
      throw toParseFailure(cause, this.lastLine + 1);
    }
  }

  /** Destroy the parser and the file stream. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.detach();
    this.parser.destroy();
    this.source.destroy();
  }
}

/** Skip leading blank records; return how many were skipped and the first non-blank one (or null). */
async function firstNonBlank(records: RecordSource): Promise<{ skipped: number; first: string[] | null }> {
  let skipped = 0;
  for (let record = await records.next(); record !== null; record = await records.next()) {
    if (!isBlankRow(record)) return { skipped, first: record };
    skipped += 1;
  }
  return { skipped, first: null };
}

/** Yield data rows up to the cap, then stop and close the stream. */
async function* dataRows(records: RecordSource, pending: string[] | null, maxRows: number, state: { truncated: boolean }): AsyncGenerator<string[]> {
  let yielded = 0;
  try {
    let record = pending ?? (await records.next());
    while (record !== null) {
      if (yielded >= maxRows) {
        state.truncated = true;
        return;
      }
      yielded += 1;
      yield record;
      record = await records.next();
    }
  } finally {
    records.close();
  }
}

/** Wire the abort signal to the file stream, so a timeout stops reading rather than leaving the parser running. */
function wireAbort(source: Readable, signal: AbortSignal | undefined): () => void {
  if (!signal) return () => undefined;
  const onAbort = () => source.destroy(signal.reason instanceof Error ? signal.reason : new Error('Reading was cancelled.'));
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

/**
 * Open a delimited text file for profiling.
 *
 * @param filePath Absolute path of a file already inside the data root.
 * @param options Row cap, cancellation, and a test seam for the byte stream.
 * @returns Detected encoding and dialect, the header, and a one-shot row iterator. Call `close()` if the rows are never iterated.
 * @throws EmptyFileError for a zero-byte file.
 * @throws ParseFailedError (during iteration) with the line a malformed record starts on.
 */
export async function openCsv(filePath: string, options: CsvReaderOptions): Promise<CsvTable & { close(): void }> {
  const openStream = options.openStream ?? ((path: string) => createReadStream(path));
  const probe = await readProbe(filePath);
  const encoding = await settleEncoding(probe, filePath, openStream, options.signal);
  const dialect = sniffCsvDialect(decodeProbe(probe.bytes, encoding, probe.complete), probe.complete);
  options.signal?.throwIfAborted();
  const source = openStream(filePath);
  const parser = createParser(dialect);
  // Errors from any stage reach the parser, and therefore the iterator below; nothing is lost here.
  pipeline(source, decoderFor(encoding.encoding), parser, () => undefined);
  const records = new RecordSource(parser, source, wireAbort(source, options.signal));
  // A signal that fired while the stream was being wired still has to stop it.
  if (options.signal?.aborted) source.destroy(options.signal.reason instanceof Error ? options.signal.reason : undefined);
  const state = { truncated: false };
  try {
    const { skipped, first } = await firstNonBlank(records);
    const header = dialect.hasHeader ? first : null;
    return {
      encoding,
      dialect,
      dialectInfo: { quoteChar: dialect.quoteChar, lineEnding: dialect.lineEnding, hasBom: encoding.bomLength > 0, confidence: dialect.confidence },
      header,
      headerRowIndex: header === null ? null : skipped,
      leadingRowsSkipped: skipped,
      notes: encoding.confidence < 1 ? [{ code: 'encoding_guessed', formats: [encoding.encoding] }] : [],
      rows: dataRows(records, header === null ? first : null, options.maxRows, state),
      get truncated() {
        return state.truncated;
      },
      close: () => records.close(),
    };
  } catch (cause) {
    records.close();
    throw cause;
  }
}
