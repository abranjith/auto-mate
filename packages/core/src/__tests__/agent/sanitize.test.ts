import { describe, expect, it } from 'vitest';
import { createSanitizer } from '../../agent/sanitize';

const KNOWN_SECRET = 'plain-looking-value-the-server-holds';

describe('boundary sanitizer', () => {
  describe('exact-match scrub — the only hard guarantee', () => {
    it('redacts a known secret even when it is not credential-shaped', () => {
      const { sanitizeText } = createSanitizer({ knownSecrets: [KNOWN_SECRET] });
      expect(sanitizeText(`the value is ${KNOWN_SECRET} today`)).toBe('the value is [redacted] today');
    });
    it('redacts every occurrence, including inside a nested payload', () => {
      const { sanitizePayload } = createSanitizer({ knownSecrets: [KNOWN_SECRET] });
      const result = sanitizePayload({ a: KNOWN_SECRET, b: { c: [KNOWN_SECRET] } });
      expect(JSON.stringify(result)).not.toContain(KNOWN_SECRET);
      expect(result).toEqual({ a: '[redacted]', b: { c: ['[redacted]'] } });
    });
    it('never emits a known secret for any generated input containing one', () => {
      const { sanitizeText } = createSanitizer({ knownSecrets: [KNOWN_SECRET] });
      const affixes = ['', ' ', '"', '{"k":"', 'prefix', '\n', '=', '...'];
      for (const before of affixes) {
        for (const after of affixes) {
          expect(sanitizeText(`${before}${KNOWN_SECRET}${after}`)).not.toContain(KNOWN_SECRET);
        }
      }
    });
  });

  describe('shape-based redaction — heuristic', () => {
    const { sanitizeText } = createSanitizer();
    it('redacts an sk-ant token in free text', () => {
      const output = sanitizeText('I tried sk-ant-api03-AbCdEf0123456789XyZ and it failed.');
      expect(output).not.toContain('sk-ant-api03');
      expect(output).toContain('I tried [redacted] and it failed.');
    });
    it('redacts a Bearer header value while the sentence survives', () => {
      const output = sanitizeText('Request failed with Bearer eyJhbGciOiJIUzI1NiJ9 header set.');
      expect(output).not.toContain('eyJhbGciOiJIUzI1NiJ9');
      expect(output).toContain('Request failed with');
      expect(output).toContain('header set.');
    });
    it('redacts an Authorization header value', () => {
      expect(sanitizeText('Authorization: abc123def456ghi789')).not.toContain('abc123def456ghi789');
    });
    it('redacts GitHub and AWS token shapes', () => {
      expect(sanitizeText('ghp_0123456789abcdefghij')).toBe('[redacted]');
      expect(sanitizeText('AKIAIOSFODNN7EXAMPLE')).toBe('[redacted]');
    });
    it('redacts a 40-character hex run but leaves a 20-character one alone', () => {
      const long = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
      const short = 'a1b2c3d4e5f607182930';
      expect(long).toHaveLength(40);
      expect(short).toHaveLength(20);
      expect(sanitizeText(long)).toBe('[redacted]');
      expect(sanitizeText(short)).toBe(short);
    });
    it('redacts a 32-character run and leaves a 31-character one alone (boundary both sides)', () => {
      expect(sanitizeText('a'.repeat(32))).toBe('[redacted]');
      expect(sanitizeText('a'.repeat(31))).toBe('a'.repeat(31));
    });
  });

  describe('path scrubbing', () => {
    it('replaces a Windows home directory with ~', () => {
      const { sanitizeText } = createSanitizer({ homeDir: 'C:\\Users\\dev' });
      expect(sanitizeText('wrote C:\\Users\\dev\\.automate\\pi\\auth.json')).toContain('~/.automate/pi/auth.json');
      expect(sanitizeText('wrote C:\\Users\\dev\\.automate\\pi\\auth.json')).not.toContain('Users');
    });
    it('replaces a POSIX home directory with ~', () => {
      const { sanitizeText } = createSanitizer({ homeDir: '/home/dev' });
      expect(sanitizeText('wrote /home/dev/.automate/config/agent.json')).toBe('wrote ~/.automate/config/agent.json');
    });
    it('leaves a path inside the workspace intact', () => {
      const { sanitizeText } = createSanitizer({ homeDir: '/home/dev', workspaceDir: '/home/dev/work/task-1' });
      expect(sanitizeText('read /home/dev/work/task-1/input.csv')).toBe('read /home/dev/work/task-1/input.csv');
    });
    it('replaces an absolute path outside both the home and the workspace', () => {
      const { sanitizeText } = createSanitizer({ homeDir: '/home/dev', workspaceDir: '/home/dev/work' });
      expect(sanitizeText('read /etc/shadow')).toBe('read <path>');
    });
    it('scrubs paths inside a structured payload and keeps it an object', () => {
      const { sanitizePayload } = createSanitizer({ homeDir: 'C:\\Users\\dev' });
      const result = sanitizePayload({ file: 'C:\\Users\\dev\\secret\\notes.txt' });
      expect(result).toEqual({ file: '~/secret/notes.txt' });
    });
  });

  describe('bounded truncation', () => {
    it('truncates over the cap with an accurate count', () => {
      const { sanitizeText } = createSanitizer({ maxTextLength: 10 });
      const output = sanitizeText('x'.repeat(25));
      expect(output).toBe(`${'x'.repeat(10)}… [truncated 15 characters]`);
    });
    it('leaves text at exactly the cap untouched', () => {
      const { sanitizeText } = createSanitizer({ maxTextLength: 10 });
      expect(sanitizeText('x'.repeat(10))).toBe('x'.repeat(10));
    });
    it('defaults the cap to 32 KiB', () => {
      const { sanitizeText } = createSanitizer();
      // Filler with frequent spaces, so no 32-character run trips the shape pass.
      const filler = 'word '.repeat(32 * 1024).slice(0, 32 * 1024);
      expect(sanitizeText(filler)).toHaveLength(32 * 1024);
      expect(sanitizeText(`${filler}x`)).toContain('[truncated 1 characters]');
    });
  });

  describe('payload handling', () => {
    it('returns sanitized text when redaction breaks JSON validity', () => {
      const { sanitizePayload } = createSanitizer({ maxTextLength: 12 });
      const result = sanitizePayload({ note: 'a much longer value than the cap allows' });
      expect(typeof result).toBe('string');
      expect(result).toContain('[truncated');
    });
    it('sanitizes a nested object at depth and returns an object', () => {
      const { sanitizePayload } = createSanitizer({ knownSecrets: [KNOWN_SECRET] });
      const result = sanitizePayload({ level1: { level2: { level3: { key: KNOWN_SECRET, keep: 42 } } } });
      expect(result).toEqual({ level1: { level2: { level3: { key: '[redacted]', keep: 42 } } } });
    });
    it('passes undefined and null through unchanged', () => {
      const { sanitizePayload } = createSanitizer();
      expect(sanitizePayload(undefined)).toBeUndefined();
      expect(sanitizePayload(null)).toBeNull();
    });
    it('handles a cyclic object without throwing', () => {
      const { sanitizePayload } = createSanitizer();
      const cyclic: Record<string, unknown> = { name: 'loop' };
      cyclic.self = cyclic;
      expect(() => sanitizePayload(cyclic)).not.toThrow();
      expect(sanitizePayload(cyclic)).toEqual({ name: 'loop', self: '[circular]' });
    });
    it('handles a 5 MB string without throwing', () => {
      const { sanitizePayload } = createSanitizer();
      expect(() => sanitizePayload('z'.repeat(5 * 1024 * 1024))).not.toThrow();
    });
    it('handles numbers, booleans, and arrays', () => {
      const { sanitizePayload } = createSanitizer();
      expect(sanitizePayload(42)).toBe(42);
      expect(sanitizePayload(true)).toBe(true);
      expect(sanitizePayload(['a', 'b'])).toEqual(['a', 'b']);
    });
  });

  it('is idempotent on already-sanitized text', () => {
    const { sanitizeText } = createSanitizer({ knownSecrets: [KNOWN_SECRET], homeDir: '/home/dev' });
    const once = sanitizeText(`${KNOWN_SECRET} at /home/dev/x with sk-ant-api03-AbCdEf0123456789XyZ`);
    expect(sanitizeText(once)).toBe(once);
  });

  it('accepts an empty options object and still redacts shapes', () => {
    expect(createSanitizer().sanitizeText('ghp_0123456789abcdefghij')).toBe('[redacted]');
  });

  it('ignores empty and non-string entries in knownSecrets', () => {
    const { sanitizeText } = createSanitizer({ knownSecrets: ['', KNOWN_SECRET] });
    expect(sanitizeText('nothing here')).toBe('nothing here');
  });
});
