import { describe, expect, it } from 'vitest';
import { computeVersionDigest, countLines, shortDigest } from '../../generation/code-version';
import { sha256Hex } from '../../generation/sha256';

const digestOf = sha256Hex;
const file = (path: string, content: string) => ({ path, sha256: digestOf(content) });

describe('sha256Hex', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  ])('matches the FIPS 180-4 vector for %j', (input, expected) => {
    expect(sha256Hex(input)).toBe(expected);
  });

  it('hashes block boundaries and multi-byte UTF-8 deterministically (node:crypto parity is asserted in the server suite)', () => {
    for (const input of ['a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'é'.repeat(100), '日本語 🐍']) {
      expect(sha256Hex(input)).toMatch(/^[0-9a-f]{64}$/);
      expect(sha256Hex(input)).toBe(sha256Hex(input));
    }
    expect(sha256Hex('a'.repeat(55))).not.toBe(sha256Hex('a'.repeat(56)));
  });
});

describe('computeVersionDigest', () => {
  const files = [file('main.py', 'print(1)\n'), file('test_main.py', 'def test_x():\n    assert True\n'), file('lib/helpers.py', 'X = 1\n')];

  it('is stable across calls and independent of the order files were supplied in', () => {
    const digest = computeVersionDigest(files);
    expect(computeVersionDigest(files)).toBe(digest);
    expect(computeVersionDigest([...files].reverse())).toBe(digest);
    expect(computeVersionDigest([files[1]!, files[2]!, files[0]!])).toBe(digest);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when one byte of one file changes', () => {
    const changed = [file('main.py', 'print(2)\n'), files[1]!, files[2]!];
    expect(computeVersionDigest(changed)).not.toBe(computeVersionDigest(files));
  });

  it('changes when a file is renamed but its content is not', () => {
    const renamed = [{ ...files[0]!, path: 'app.py' }, files[1]!, files[2]!];
    expect(computeVersionDigest(renamed)).not.toBe(computeVersionDigest(files));
  });

  it('never collides between a one-file and a two-file version', () => {
    const one = computeVersionDigest([files[0]!]);
    const two = computeVersionDigest([files[0]!, files[1]!]);
    expect(one).not.toBe(two);
    expect(computeVersionDigest([])).not.toBe(one);
  });

  it('ignores any extra fields on the inputs, so only path and sha256 define identity', () => {
    const decorated = files.map((entry) => ({ ...entry, content: 'ignored', role: 'script' }));
    expect(computeVersionDigest(decorated)).toBe(computeVersionDigest(files));
  });

  it('is the documented canonical JSON of sorted {path, sha256} pairs', () => {
    const second = file('b.py', 'b');
    const first = file('a.py', 'a');
    const expected = digestOf(`[{"path":"a.py","sha256":"${first.sha256}"},{"path":"b.py","sha256":"${second.sha256}"}]`);
    expect(computeVersionDigest([second, first])).toBe(expected);
  });
});

describe('countLines and shortDigest', () => {
  it.each([
    ['', 0],
    ['a', 1],
    ['a\n', 1],
    ['a\nb', 2],
    ['a\r\nb\r\n', 2],
    ['\n', 1],
    ['a\n\n', 2],
  ])('counts %j as %i lines', (content, expected) => {
    expect(countLines(content)).toBe(expected);
  });

  it('shortens a digest to 12 characters for display only', () => {
    expect(shortDigest('0123456789abcdef'.repeat(4))).toBe('0123456789ab');
  });
});
