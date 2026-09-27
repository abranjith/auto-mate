import { describe, expect, it } from 'vitest';
import { ARTIFACT_CSP, FORMULA_PREFIXES, SANDBOX_ATTRIBUTE, buildContentDisposition, describeArtifactSafety, hasFormulaPrefix, sanitizeDownloadFilename } from '../../artifacts/artifact-safety';
import { RENDER_MODES } from '../../artifacts/artifact-type';

describe('ARTIFACT_CSP', () => {
  // Loosening the policy means editing this literal, next to the reason it is tight.
  it('is exactly the D12 policy', () => {
    expect(ARTIFACT_CSP).toBe("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'; sandbox allow-scripts");
  });

  it('denies by default, repeats the sandbox, and grants neither eval nor any network destination', () => {
    expect(ARTIFACT_CSP).toContain("default-src 'none'");
    expect(ARTIFACT_CSP).toContain('sandbox allow-scripts');
    expect(ARTIFACT_CSP).not.toContain("'unsafe-eval'");
    expect(ARTIFACT_CSP).not.toContain('connect-src');
    expect(ARTIFACT_CSP).not.toMatch(/https?:/);
    // Built, not typed: the literal token must appear nowhere in packages/core or packages/web.
    expect(ARTIFACT_CSP).not.toContain(['allow', 'same', 'origin'].join('-'));
    expect(ARTIFACT_CSP).not.toMatch(/[\r\n]/);
  });

  it('grants the frame scripts only', () => {
    expect(SANDBOX_ATTRIBUTE).toBe('allow-scripts');
  });
});

describe('hasFormulaPrefix', () => {
  it.each(FORMULA_PREFIXES.map((prefix) => [JSON.stringify(prefix), `${prefix}cmd`]))('flags a cell starting with %s', (_label, cell) => {
    expect(hasFormulaPrefix(cell)).toBe(true);
  });

  it.each([
    ['a quoted formula', '"=x"'],
    ['a leading space', ' =x'],
    ['plain text', 'total'],
    ['an empty cell', ''],
    ['a positive number', '42'],
  ])('does not flag %s', (_label, cell) => {
    expect(hasFormulaPrefix(cell)).toBe(false);
  });

  it('counts a plain negative number: a known false positive, counted and never corrected', () => {
    expect(hasFormulaPrefix('-5')).toBe(true);
    expect(hasFormulaPrefix('-0.25')).toBe(true);
  });

  it('flags the classic DDE payload', () => {
    expect(hasFormulaPrefix("=cmd|'/c calc'!A1")).toBe(true);
  });
});

describe('sanitizeDownloadFilename', () => {
  it.each([
    ['../../etc/passwd', 'passwd'],
    ['C:\\evil.csv', 'evil.csv'],
    ['.hidden.csv', 'hidden.csv'],
    ['..', 'download'],
    ['', 'download'],
    ['report"; x=.csv', 'report__ x=.csv'],
    ['a\u0000b.csv', 'ab.csv'],
    ['a\r\nContent-Type: text/html.csv', 'html.csv'],
    ['a\r\nSet-Cookie: x.csv', 'aSet-Cookie_ x.csv'],
    ['a..b.csv', 'a.b.csv'],
    ['con.csv', '_con.csv'],
    ['NUL', '_NUL'],
    ['com1.txt', '_com1.txt'],
    ['trailing. ', 'trailing'],
  ])('%j becomes %j', (input, expected) => {
    expect(sanitizeDownloadFilename(input)).toBe(expected);
  });

  it('keeps unicode and never leaves a separator, control character, or ..', () => {
    const hostile = ['résumé.csv', '日本語.xlsx', '../..\\x/../y.csv', 'a\tb.csv', '\u202Egnp.exe'];
    for (const name of hostile) {
      const safe = sanitizeDownloadFilename(name);
      expect(safe).not.toMatch(/[\\/]/);
      expect([...safe].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)).toBe(false);
      expect(safe).not.toContain('..');
    }
    expect(sanitizeDownloadFilename('résumé.csv')).toBe('résumé.csv');
  });

  it('caps a 500-character name while keeping its extension', () => {
    const safe = sanitizeDownloadFilename(`${'x'.repeat(500)}.csv`);
    expect([...safe].length).toBe(200);
    expect(safe.endsWith('.csv')).toBe(true);
  });
});

describe('buildContentDisposition', () => {
  it('pairs an ASCII fallback with the RFC 5987 form for unicode', () => {
    expect(buildContentDisposition('attachment', 'résumé.csv')).toBe(`attachment; filename="r_sum_.csv"; filename*=UTF-8''r%C3%A9sum%C3%A9.csv`);
  });

  it('cannot be split or injected by a hostile name', () => {
    for (const name of ['"; rm -rf /', 'a\r\nSet-Cookie: x=1.csv', 'x"y.csv', "it's (1)*.csv"]) {
      const header = buildContentDisposition('inline', name);
      expect(header).not.toMatch(/[\r\n]/);
      expect(header.match(/"/g)).toHaveLength(2);
      expect(header.split(';').map((part) => part.trim().split('=')[0])).toEqual(['inline', 'filename', 'filename*']);
    }
    expect(buildContentDisposition('inline', "it's (1)*.csv")).toContain("filename*=UTF-8''it%27s%20%281%29_.csv");
  });
});

describe('describeArtifactSafety', () => {
  it('says the AI wrote a generated report and that it cannot reach the rest of the app', () => {
    const lines = describeArtifactSafety('sandboxed_html').join(' ');
    expect(lines).toMatch(/AI wrote/);
    expect(lines).toMatch(/cannot read or change the rest of this app/);
    expect(lines).toMatch(/cannot send anything over the network/);
    expect(lines).toMatch(/Python script that made it ran on your computer/);
  });

  it('does not attach the generated-code caveat to trusted renderers', () => {
    for (const mode of ['table', 'image', 'markdown', 'text'] as const) {
      const lines = describeArtifactSafety(mode).join(' ');
      expect(lines).not.toMatch(/AI wrote/);
      expect(lines).not.toMatch(/rest of this app/);
    }
  });

  it('has wording for every render mode and returns a copy', () => {
    for (const mode of RENDER_MODES) expect(describeArtifactSafety(mode).length).toBeGreaterThan(0);
    const copy = describeArtifactSafety('text');
    copy.push('mutated');
    expect(describeArtifactSafety('text')).not.toContain('mutated');
  });
});
