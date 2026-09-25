// ---------------------------------------------------------------------------
// Character-encoding detection (FEAT-104 TASK-002).
//
// Module invariant: pure and synchronous over a byte buffer; no Node
// built-ins. `TextDecoder` is a web platform API, available in browsers and in
// Node's full-ICU build.
//
// The whole detector is: a byte-order mark if there is one; otherwise strict
// UTF-8, which correctly REJECTS latin-1 bytes; otherwise windows-1252, the
// common Excel export and a superset of latin-1.
// ---------------------------------------------------------------------------

/** Encodings this application decodes text files with. */
export type TextEncodingName = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

/** What the detector decided, how sure it is, and how many BOM bytes to skip. */
export interface EncodingDetection {
  readonly encoding: TextEncodingName;
  readonly confidence: number;
  readonly bomLength: number;
}

const BOMS: readonly { bytes: readonly number[]; encoding: TextEncodingName }[] = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: 'utf-8' },
  { bytes: [0xff, 0xfe], encoding: 'utf-16le' },
  { bytes: [0xfe, 0xff], encoding: 'utf-16be' },
];

/**
 * Detect a byte-order mark.
 *
 * @param bytes The start of a file.
 * @returns The BOM's encoding and length, or null.
 * @example detectBom(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))?.encoding // 'utf-8'
 */
export function detectBom(bytes: Uint8Array): { encoding: TextEncodingName; length: number } | null {
  const bom = BOMS.find(({ bytes: mark }) => mark.every((byte, index) => bytes[index] === byte));
  return bom ? { encoding: bom.encoding, length: bom.bytes.length } : null;
}

/**
 * Report whether bytes are valid UTF-8.
 *
 * When the probe is only the start of a file, a multi-byte sequence split by
 * the probe boundary is not an error: streaming mode holds it back instead of
 * rejecting it. When the probe is the whole file, a dangling sequence is one.
 *
 * @param bytes Bytes to validate.
 * @param complete Whether these bytes are the entire file.
 * @returns True when every byte decodes as UTF-8.
 */
export function isValidUtf8(bytes: Uint8Array, complete: boolean): boolean {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    decoder.decode(bytes, { stream: !complete });
    if (complete) decoder.decode();
    return true;
  } catch {
    // A fatal decoder throws TypeError on the first invalid sequence; that is the answer.
    return false;
  }
}

function hasNonAscii(bytes: Uint8Array): boolean {
  for (const byte of bytes) if (byte >= 0x80) return true;
  return false;
}

/**
 * Detect the encoding of a text file from its first bytes.
 *
 * @param probe The first bytes of the file (the application uses 64 KiB).
 * @param complete Whether the probe is the whole file.
 * @returns The encoding, a confidence, and the BOM length to skip.
 * @example detectEncoding(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), true).encoding // 'windows-1252'
 */
export function detectEncoding(probe: Uint8Array, complete = false): EncodingDetection {
  const bom = detectBom(probe);
  if (bom) return { encoding: bom.encoding, confidence: 1, bomLength: bom.length };
  if (isValidUtf8(probe, complete)) {
    // Pure ASCII is valid in every candidate; only a complete file makes that certain.
    const confidence = hasNonAscii(probe) || complete ? 1 : 0.5;
    return { encoding: 'utf-8', confidence, bomLength: 0 };
  }
  return { encoding: 'windows-1252', confidence: 0.5, bomLength: 0 };
}

/**
 * Decode a probe for sniffing, without its BOM.
 *
 * A multi-byte sequence split at the end of an incomplete probe is held back
 * rather than rendered as a replacement character.
 *
 * @param probe The first bytes of the file.
 * @param detection The detected encoding.
 * @param complete Whether the probe is the whole file.
 * @returns The decoded text.
 */
export function decodeProbe(probe: Uint8Array, detection: EncodingDetection, complete = false): string {
  const decoder = new TextDecoder(detection.encoding);
  return decoder.decode(probe.subarray(detection.bomLength), { stream: !complete });
}
