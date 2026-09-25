import { describe, expect, it } from 'vitest';
import { decodeProbe, detectBom, detectEncoding, isValidUtf8 } from '../../ingestion/encoding';

const utf8 = (value: string) => new TextEncoder().encode(value);
const bytes = (...values: number[]) => new Uint8Array(values);

describe('detectEncoding', () => {
  it.each([
    ['utf-8', [0xef, 0xbb, 0xbf, 0x61], 3],
    ['utf-16le', [0xff, 0xfe, 0x61, 0x00], 2],
    ['utf-16be', [0xfe, 0xff, 0x00, 0x61], 2],
  ] as const)('detects a %s byte-order mark and reports its length', (encoding, probe, bomLength) => {
    expect(detectEncoding(bytes(...probe))).toEqual({ encoding, confidence: 1, bomLength });
  });

  it('detects UTF-8 with multi-byte characters and no BOM, with full confidence', () => {
    expect(detectEncoding(utf8('name\nZoë\n東京\n'))).toEqual({ encoding: 'utf-8', confidence: 1, bomLength: 0 });
  });

  it('falls back to windows-1252 for a latin-1 0xE9 and decodes it to é', () => {
    const probe = bytes(0x63, 0x61, 0x66, 0xe9, 0x0a);
    const detection = detectEncoding(probe, true);
    expect(detection.encoding).toBe('windows-1252');
    expect(decodeProbe(probe, detection, true)).toBe('café\n');
  });

  it('still detects UTF-8 when the probe boundary splits a multi-byte sequence', () => {
    const whole = utf8('ab€');
    const split = whole.subarray(0, whole.length - 1);
    expect(detectEncoding(split, false).encoding).toBe('utf-8');
    expect(decodeProbe(split, detectEncoding(split, false), false)).toBe('ab');
  });

  it('treats the same dangling sequence as invalid when it is the whole file', () => {
    const whole = utf8('ab€');
    expect(isValidUtf8(whole.subarray(0, whole.length - 1), true)).toBe(false);
    expect(detectEncoding(whole.subarray(0, whole.length - 1), true).encoding).toBe('windows-1252');
  });

  it('reports lower confidence for an ASCII-only partial probe, full confidence for a whole ASCII file', () => {
    expect(detectEncoding(utf8('a,b\n1,2\n'), false).confidence).toBe(0.5);
    expect(detectEncoding(utf8('a,b\n1,2\n'), true).confidence).toBe(1);
  });

  it('decodes UTF-16 probes without their BOM', () => {
    const le = bytes(0xff, 0xfe, 0x61, 0x00, 0x2c, 0x00, 0x62, 0x00);
    expect(decodeProbe(le, detectEncoding(le), true)).toBe('a,b');
    const be = bytes(0xfe, 0xff, 0x00, 0x61);
    expect(decodeProbe(be, detectEncoding(be), true)).toBe('a');
  });

  it('strips a UTF-8 BOM so it cannot leak into the first header name', () => {
    const probe = bytes(0xef, 0xbb, 0xbf, ...utf8('id,name'));
    expect(decodeProbe(probe, detectEncoding(probe), true)).toBe('id,name');
  });

  it('finds no BOM in ordinary text or an empty buffer', () => {
    expect(detectBom(utf8('abc'))).toBeNull();
    expect(detectBom(new Uint8Array())).toBeNull();
  });
});
