// An independent ZIP reader for FEAT-109's tests: walks the end record and the
// central directory, checks each local header, data descriptor, size, and
// CRC-32, and returns the entries. Not the writer's code, so a writer bug is
// not mirrored here. A plain module, not a `.test.ts`.

import { crc32 } from 'node:zlib';

export interface ReadEntry { readonly name: string; readonly data: Buffer; readonly flags: number; readonly method: number }

function fail(message: string): never { throw new Error(`Invalid ZIP: ${message}`); }

/**
 * Parse a whole store-only ZIP.
 * @throws Error naming the first structural problem found.
 */
export function readZip(zip: Buffer): ReadEntry[] {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end !== zip.length - 22) fail('end record missing or followed by data');
  const count = zip.readUInt16LE(end + 10);
  let cursor = zip.readUInt32LE(end + 16);
  if (cursor + zip.readUInt32LE(end + 12) !== end) fail('central directory size or offset is wrong');
  const entries: ReadEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) fail(`central header ${index} signature`);
    const flags = zip.readUInt16LE(cursor + 8);
    const method = zip.readUInt16LE(cursor + 10);
    const crc = zip.readUInt32LE(cursor + 16);
    const size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const offset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (zip.readUInt32LE(offset) !== 0x04034b50) fail(`local header ${index} signature`);
    const localNameLength = zip.readUInt16LE(offset + 26);
    if (zip.subarray(offset + 30, offset + 30 + localNameLength).toString('utf8') !== name) fail(`local name ${index}`);
    const dataStart = offset + 30 + localNameLength;
    const data = zip.subarray(dataStart, dataStart + size);
    if ((crc32(data) >>> 0) !== crc) fail(`CRC of ${name}`);
    if (zip.readUInt32LE(dataStart + size) !== 0x08074b50 || zip.readUInt32LE(dataStart + size + 4) !== crc) fail(`data descriptor of ${name}`);
    entries.push({ name, data: Buffer.from(data), flags, method });
    cursor += 46 + nameLength;
  }
  return entries;
}
