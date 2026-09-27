// ---------------------------------------------------------------------------
// A streaming, STORE-ONLY ZIP writer (FEAT-109 TASK-006, D12).
//
// "Download all" needs a ZIP, and a ZIP without compression is a local header
// per entry, the bytes, a data descriptor, a central directory, and a CRC that
// `node:zlib` already computes. Most outputs are png/xlsx/pdf and already
// compressed, so deflate would buy little in exchange for an archive
// dependency in the path that serves a person's own data. Every entry is
// method 0 with general-purpose bit 3 (sizes and CRC follow the data, so it
// streams in one pass) and bit 11 (UTF-8 names).
//
// Zip64 is NOT implemented. Anything past 4 GiB — one entry, or the archive —
// is REFUSED before a byte is written, rather than silently emitting an
// archive whose offsets have wrapped. FEAT-108's 1 GiB output cap makes that
// unreachable today; refusing is how the boundary stays honest if it moves.
//
// Entry names are sanitized display names, deduplicated with " (2)", and
// asserted to contain no separator and no `..`: an archive this application
// produces must not be one whose extraction escapes its directory.
// ---------------------------------------------------------------------------

import { createReadStream } from 'node:fs';
import { once } from 'node:events';
import type { Writable } from 'node:stream';
import { crc32 } from 'node:zlib';
import { ArchiveTooLargeError, sanitizeDownloadFilename } from '@automate/core';

/** Largest value a 32-bit ZIP size or offset field holds. */
export const ZIP32_LIMIT = 0xffff_ffff;

export interface ZipEntrySource {
  /** Display filename; sanitized and deduplicated here. */
  readonly name: string;
  /** Absolute path of the bytes. */
  readonly path: string;
  readonly size: number;
  readonly modifiedAt: Date;
}

interface PlannedEntry extends ZipEntrySource { readonly entryName: string; readonly nameBytes: Buffer }

const LOCAL_HEADER = 30;
const DESCRIPTOR = 16;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;
const FLAGS = 0x0008 | 0x0800;

/**
 * Give every entry a safe, unique name: `report.csv`, `report (2).csv`, …
 * @param names Display names in archive order.
 * @returns Sanitized names with no separator and no `..`.
 */
export function uniqueEntryNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const safe = sanitizeDownloadFilename(name);
    const dot = safe.lastIndexOf('.');
    const [stem, extension] = dot > 0 ? [safe.slice(0, dot), safe.slice(dot)] : [safe, ''];
    let candidate = safe;
    for (let copy = 2; used.has(candidate.toLowerCase()); copy += 1) candidate = `${stem} (${copy})${extension}`;
    if (/[\\/]/.test(candidate) || candidate.includes('..')) throw new Error('An archive entry name must be a plain file name.');
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

/** MS-DOS time and date fields for a timestamp (local time, 2-second resolution, 1980 floor). */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return { time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2), date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate() };
}

/**
 * The exact archive size for these entries, so a refusal happens before any byte is written.
 * @param entries The planned entries.
 * @returns Total bytes of the archive.
 */
export function archiveSize(entries: readonly { readonly nameBytes: Buffer; readonly size: number }[]): number {
  return entries.reduce((sum, entry) => sum + LOCAL_HEADER + entry.nameBytes.length + entry.size + DESCRIPTOR + CENTRAL_HEADER + entry.nameBytes.length, 0) + END_RECORD;
}

/**
 * Plan an archive: name every entry and refuse anything Zip64-less ZIP cannot describe.
 * @param sources The files in archive order.
 * @param maxArchiveBytes The configured ceiling (never above 4 GiB).
 * @returns The entries with their final names.
 * @throws ArchiveTooLargeError when one entry or the whole archive is too large.
 */
export function planArchive(sources: readonly ZipEntrySource[], maxArchiveBytes: number): PlannedEntry[] {
  const limit = Math.min(maxArchiveBytes, ZIP32_LIMIT);
  const names = uniqueEntryNames(sources.map(({ name }) => name));
  const planned = sources.map((source, index) => ({ ...source, entryName: names[index]!, nameBytes: Buffer.from(names[index]!, 'utf8') }));
  if (planned.some((entry) => entry.size > ZIP32_LIMIT) || archiveSize(planned) > limit || planned.length > 0xffff) throw new ArchiveTooLargeError(limit);
  return planned;
}

function localHeader(entry: PlannedEntry): Buffer {
  const { time, date } = dosDateTime(entry.modifiedAt);
  const header = Buffer.alloc(LOCAL_HEADER);
  header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(FLAGS, 6); header.writeUInt16LE(0, 8);
  header.writeUInt16LE(time, 10); header.writeUInt16LE(date, 12);
  // CRC and sizes are zero here and follow the data in the descriptor (bit 3).
  header.writeUInt16LE(entry.nameBytes.length, 26); header.writeUInt16LE(0, 28);
  return Buffer.concat([header, entry.nameBytes]);
}

function descriptor(crc: number, size: number): Buffer {
  const buffer = Buffer.alloc(DESCRIPTOR);
  buffer.writeUInt32LE(0x08074b50, 0); buffer.writeUInt32LE(crc >>> 0, 4); buffer.writeUInt32LE(size, 8); buffer.writeUInt32LE(size, 12);
  return buffer;
}

function centralHeader(entry: PlannedEntry, crc: number, offset: number): Buffer {
  const { time, date } = dosDateTime(entry.modifiedAt);
  const header = Buffer.alloc(CENTRAL_HEADER);
  header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(FLAGS, 8); header.writeUInt16LE(0, 10);
  header.writeUInt16LE(time, 12); header.writeUInt16LE(date, 14); header.writeUInt32LE(crc >>> 0, 16); header.writeUInt32LE(entry.size, 20); header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(entry.nameBytes.length, 28); header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, entry.nameBytes]);
}

function endRecord(count: number, directorySize: number, directoryOffset: number): Buffer {
  const record = Buffer.alloc(END_RECORD);
  record.writeUInt32LE(0x06054b50, 0); record.writeUInt16LE(count, 8); record.writeUInt16LE(count, 10); record.writeUInt32LE(directorySize, 12); record.writeUInt32LE(directoryOffset, 16);
  return record;
}

/** Write with backpressure. */
async function put(output: Writable, chunk: Buffer, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (!output.write(chunk)) await once(output, 'drain', { signal });
}

/** Stream one file's bytes, returning its CRC and byte count. The read stream is closed on abort. */
async function streamEntry(entry: PlannedEntry, output: Writable, signal: AbortSignal): Promise<{ crc: number; size: number }> {
  let crc = 0;
  let size = 0;
  for await (const chunk of createReadStream(entry.path, { signal })) {
    const bytes = chunk as Buffer;
    crc = crc32(bytes, crc);
    size += bytes.length;
    await put(output, bytes, signal);
  }
  if (size !== entry.size) throw new Error('An output file changed size while it was being archived.');
  return { crc, size };
}

/**
 * Stream a store-only ZIP of the planned entries to `output`, then end it.
 * @param entries From `planArchive`.
 * @param output Usually the HTTP response.
 * @param signal Aborts mid-stream (the client went away); file handles are released.
 */
export async function writeStoreZip(entries: readonly PlannedEntry[], output: Writable, signal: AbortSignal): Promise<void> {
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const header = localHeader(entry);
    await put(output, header, signal);
    const { crc, size } = await streamEntry(entry, output, signal);
    await put(output, descriptor(crc, size), signal);
    central.push(centralHeader(entry, crc, offset));
    offset += header.length + size + DESCRIPTOR;
  }
  const directory = Buffer.concat(central);
  await put(output, directory, signal);
  await put(output, endRecord(entries.length, directory.length, offset), signal);
  output.end();
}
