// ---------------------------------------------------------------------------
// Upload intake (FEAT-104 TASK-008).
//
// One multipart file part is streamed straight to disk, counted, hashed, and
// probed in a single pass. The size cap is enforced WHILE the bytes arrive:
// the moment the count passes the limit the write is abandoned, the partial
// file unlinked, and `UploadTooLargeError` raised — nothing is buffered to
// discover that a file was too big. Format is sniffed from the first 64 KiB
// of content after the stream completes. On any failure the partial file is
// removed, so a rejected upload leaves nothing behind.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import busboy from 'busboy';
import {
  EmptyFileError,
  PROBE_BYTES,
  UploadTooLargeError,
  ValidationError,
  detectFileFormat,
  type FileFormat,
} from '@automate/core';
import { stripControlCharacters, type UploadFileStore } from './upload-file-store';

/** Multipart framing is small; a request larger than the limit plus this is too big before a byte is read. */
const MULTIPART_ALLOWANCE = 64 * 1024;
const MAX_ORIGINAL_FILENAME = 255;

/**
 * The parts of an incoming HTTP request that intake reads. Typed structurally
 * so this directory imports nothing HTTP-related: ingestion receives bytes and
 * transmits nothing, and a source scan holds it to that.
 */
export interface UploadRequest extends Readable {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly complete: boolean;
}

/** Everything intake learned about one received file. */
export interface ReceivedUpload {
  /** Absolute path of the received bytes, still under `uploads/staged/`. */
  readonly incomingPath: string;
  readonly originalFilename: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly format: FileFormat;
}

export interface IntakeOptions {
  readonly store: UploadFileStore;
  readonly maxUploadBytes: number;
}

/** Counts, hashes, and keeps the first bytes of everything passing through; fails the moment the cap is passed. */
class Meter extends Transform {
  bytes = 0;
  private readonly hash = createHash('sha256');
  private readonly head: Buffer[] = [];
  private headBytes = 0;

  constructor(private readonly limit: number) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void): void {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) {
      callback(new UploadTooLargeError(this.bytes, this.limit, false));
      return;
    }
    this.hash.update(chunk);
    if (this.headBytes < PROBE_BYTES) {
      this.head.push(chunk.subarray(0, PROBE_BYTES - this.headBytes));
      this.headBytes += Math.min(chunk.length, PROBE_BYTES - this.headBytes);
    }
    callback(null, chunk);
  }

  digest(): string {
    return this.hash.digest('hex');
  }

  probe(): Uint8Array {
    return Buffer.concat(this.head);
  }
}

/** The client's filename as a display label: trimmed, capped, never a path this application uses. */
function displayFilename(reported: string | undefined): string {
  const name = stripControlCharacters(reported ?? '').trim();
  return (name || 'upload').slice(0, MAX_ORIGINAL_FILENAME);
}

/** Refuse, before reading anything, a request whose declared length already exceeds the limit. */
function assertDeclaredLength(request: UploadRequest, limit: number): void {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit + MULTIPART_ALLOWANCE) throw new UploadTooLargeError(declared, limit);
}

interface FilePart {
  readonly stream: Readable;
  readonly filename: string;
  readonly mimeType: string;
}

const INTERRUPTED = 'The upload was interrupted before the whole file arrived. Try again.';
const NO_FILE = 'No file was attached. Choose a .csv, .tsv, or .xlsx file.';

/**
 * Parse the multipart body and hand its single file part to `onFile`.
 *
 * On any failure the request stops feeding the parser and is drained, the
 * file part is destroyed, and the rejection waits until `onFile` has settled
 * — so its write stream is closed before the caller removes the partial file.
 */
function awaitFilePart<T>(request: UploadRequest, onFile: (part: FilePart) => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let parser: busboy.Busboy;
    try {
      parser = busboy({ headers: request.headers, defParamCharset: 'utf8', limits: { files: 1, fields: 10, parts: 20 } });
    } catch {
      reject(new ValidationError('Attach a file using a multipart form upload.'));
      return;
    }
    let handled: Promise<T> | null = null;
    let part: Readable | null = null;
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      request.unpipe(parser);
      request.resume();
      part?.destroy(error instanceof Error ? error : undefined);
      void (handled ?? Promise.resolve()).then(() => reject(error), () => reject(error));
    };
    parser.on('file', (_field, stream, info) => {
      part = stream;
      handled = onFile({ stream, filename: info.filename, mimeType: info.mimeType });
      handled.catch(fail);
    });
    parser.on('filesLimit', () => fail(new ValidationError('Attach one file per upload.')));
    parser.on('error', () => fail(new ValidationError(INTERRUPTED)));
    parser.on('close', () => {
      if (handled === null) return fail(new ValidationError(NO_FILE));
      handled.then((value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      }, fail);
    });
    request.on('close', () => {
      if (!request.complete) fail(new ValidationError(INTERRUPTED));
    });
    request.pipe(parser);
  });
}

/**
 * Receive one uploaded file from a multipart request.
 *
 * @param request The incoming HTTP request.
 * @param options The file store and the size limit.
 * @returns What was received; the bytes sit at `incomingPath` until the caller stages them.
 * @throws UploadTooLargeError the moment the stream passes the limit (the partial file is removed).
 * @throws EmptyFileError for a zero-byte file; UnsupportedFileFormatError for `.xls` and non-tabular content.
 * @throws ValidationError for a request with no file part, several file parts, or an interrupted transfer.
 */
export async function receiveUpload(request: UploadRequest, options: IntakeOptions): Promise<ReceivedUpload> {
  const incomingPath = options.store.incomingPath();
  try {
    assertDeclaredLength(request, options.maxUploadBytes);
    return await awaitFilePart(request, async (part): Promise<ReceivedUpload> => {
      const meter = new Meter(options.maxUploadBytes);
      await pipeline(part.stream, meter, createWriteStream(incomingPath, { flags: 'wx' }));
      if (meter.bytes === 0) throw new EmptyFileError();
      const format = detectFileFormat(meter.probe(), { filename: part.filename, mimeType: part.mimeType });
      return {
        incomingPath,
        originalFilename: displayFilename(part.filename),
        mimeType: part.mimeType || 'application/octet-stream',
        byteSize: meter.bytes,
        sha256: meter.digest(),
        format,
      };
    });
  } catch (cause) {
    if (!request.complete) request.resume();
    await options.store.discardIncoming(incomingPath);
    throw cause;
  }
}
