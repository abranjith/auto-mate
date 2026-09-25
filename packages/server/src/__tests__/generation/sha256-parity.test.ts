import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@automate/core';

// The browser-safe SHA-256 in packages/core defines a code version's digest;
// the server hashes file bytes with node:crypto. The two must agree exactly.
describe('sha256Hex parity with node:crypto', () => {
  it('agrees on block boundaries, multi-byte UTF-8, lone surrogates, and random text', () => {
    const inputs = ['', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(65), 'a'.repeat(119), 'a'.repeat(120), 'é'.repeat(100), '日本語 🐍 text', '\uD800 lone', 'x'.repeat(100_000)];
    for (let index = 0; index < 50; index += 1) inputs.push(randomBytes(1 + index * 7).toString('latin1'));
    for (const input of inputs) expect(sha256Hex(input)).toBe(createHash('sha256').update(input, 'utf8').digest('hex'));
  });
});
