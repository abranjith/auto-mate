import { describe, expect, it } from 'vitest';
import { ARTIFACT_TYPES, ARTIFACT_TYPE_POLICY, RENDER_MODES, extensionOf, isArtifactType, mimeTypeFor, renderModeFor, resolveArtifactType } from '../../artifacts/artifact-type';

// Memory's manifest artifact model, verbatim. Adding a type is a deliberate edit here AND in the policy.
const MEMORY_NINE = ['csv', 'plotly-html', 'html', 'image', 'markdown', 'json', 'text', 'xlsx', 'pdf'];

describe('artifact type policy', () => {
  it('holds exactly memory\'s nine types, and the policy covers each once', () => {
    expect([...ARTIFACT_TYPES].sort()).toEqual([...MEMORY_NINE].sort());
    expect(Object.keys(ARTIFACT_TYPE_POLICY).sort()).toEqual([...MEMORY_NINE].sort());
    expect(Object.isFrozen(ARTIFACT_TYPE_POLICY)).toBe(true);
  });

  it('never admits svg, for any type', () => {
    for (const type of ARTIFACT_TYPES) {
      expect(ARTIFACT_TYPE_POLICY[type].extensions).not.toContain('.svg');
      expect(resolveArtifactType(type, 'chart.svg')).toEqual({ ok: false, reason: 'extension_not_allowed' });
    }
    expect(resolveArtifactType(null, 'chart.svg')).toEqual({ ok: false, reason: 'extension_not_allowed' });
  });

  it('gives every extension exactly one MIME type and a known render mode', () => {
    for (const type of ARTIFACT_TYPES) {
      const policy = ARTIFACT_TYPE_POLICY[type];
      expect(RENDER_MODES).toContain(policy.renderMode);
      expect(Object.keys(policy.mimeTypes).sort()).toEqual([...policy.extensions].sort());
      for (const extension of policy.extensions) {
        expect(extension).toMatch(/^\.[a-z0-9]+$/);
        expect(mimeTypeFor(type, extension)).toBe(policy.mimeTypes[extension]);
        expect(renderModeFor(type, extension)).toBe(policy.renderMode);
      }
    }
  });

  it('renders generated HTML only in the sandboxed frame, and tables through the table renderer', () => {
    expect(ARTIFACT_TYPE_POLICY.html.renderMode).toBe('sandboxed_html');
    expect(ARTIFACT_TYPE_POLICY['plotly-html'].renderMode).toBe('sandboxed_html');
    expect(ARTIFACT_TYPE_POLICY.pdf.renderMode).toBe('sandboxed_pdf');
    expect(ARTIFACT_TYPE_POLICY.csv.renderMode).toBe('table');
    expect(ARTIFACT_TYPE_POLICY.xlsx.renderMode).toBe('table');
    expect(ARTIFACT_TYPES.filter((type) => ARTIFACT_TYPE_POLICY[type].previewable).sort()).toEqual(['json', 'markdown', 'text']);
  });

  it('throws for any type/extension pair outside the policy', () => {
    expect(() => mimeTypeFor('csv', '.exe')).toThrow(RangeError);
    expect(() => mimeTypeFor('image', '.svg')).toThrow(RangeError);
    expect(() => renderModeFor('pdf', '.html')).toThrow(RangeError);
    expect(() => mimeTypeFor('nonsense' as never, '.csv')).toThrow(RangeError);
  });
});

describe('resolveArtifactType', () => {
  it('accepts a declared type whose extension is on its allowlist, case-insensitively', () => {
    expect(resolveArtifactType('csv', 'summary.csv')).toEqual({ ok: true, type: 'csv', extension: '.csv' });
    expect(resolveArtifactType('image', 'Chart.JPEG')).toEqual({ ok: true, type: 'image', extension: '.jpeg' });
    expect(resolveArtifactType('plotly-html', 'chart.htm')).toEqual({ ok: true, type: 'plotly-html', extension: '.htm' });
    expect(resolveArtifactType('html', 'report.html')).toEqual({ ok: true, type: 'html', extension: '.html' });
  });

  it('refuses a declared type whose extension the policy does not allow', () => {
    expect(resolveArtifactType('image', 'payload.svg')).toEqual({ ok: false, reason: 'extension_not_allowed' });
    expect(resolveArtifactType('csv', 'report.exe')).toEqual({ ok: false, reason: 'extension_not_allowed' });
    expect(resolveArtifactType('text', 'data.csv')).toEqual({ ok: false, reason: 'extension_not_allowed' });
    expect(resolveArtifactType('csv', 'report.html')).toEqual({ ok: false, reason: 'extension_not_allowed' });
  });

  it('refuses an unknown declared type and a file with no extension', () => {
    expect(resolveArtifactType('plotly-json', 'chart.json')).toEqual({ ok: false, reason: 'unknown_type' });
    expect(resolveArtifactType('svg', 'a.svg')).toEqual({ ok: false, reason: 'unknown_type' });
    expect(resolveArtifactType('csv', 'README')).toEqual({ ok: false, reason: 'no_extension' });
    expect(resolveArtifactType('csv', '.csv')).toEqual({ ok: false, reason: 'no_extension' });
    expect(resolveArtifactType('csv', '')).toEqual({ ok: false, reason: 'no_extension' });
  });

  it('types an undeclared file by extension, preferring plain html over plotly-html', () => {
    expect(resolveArtifactType(null, 'extra.csv')).toEqual({ ok: true, type: 'csv', extension: '.csv' });
    expect(resolveArtifactType(null, 'report.html')).toEqual({ ok: true, type: 'html', extension: '.html' });
    expect(resolveArtifactType(null, 'notes.md')).toEqual({ ok: true, type: 'markdown', extension: '.md' });
    expect(resolveArtifactType(null, 'photo.gif')).toEqual({ ok: true, type: 'image', extension: '.gif' });
    expect(resolveArtifactType(null, 'tool.exe')).toEqual({ ok: false, reason: 'extension_not_allowed' });
  });

  it('reads only the extension of a hostile name, never treating it as a path', () => {
    expect(resolveArtifactType('csv', '../../../evil.csv')).toEqual({ ok: true, type: 'csv', extension: '.csv' });
    expect(resolveArtifactType('csv', 'C:\\windows\\x.csv')).toEqual({ ok: true, type: 'csv', extension: '.csv' });
    expect(resolveArtifactType('csv', 'dir.csv/evil.exe')).toEqual({ ok: false, reason: 'extension_not_allowed' });
  });
});

describe('extensionOf and isArtifactType', () => {
  it('follows path.extname for dotfiles and multi-dot names', () => {
    expect(extensionOf('a.tar.gz')).toBe('.gz');
    expect(extensionOf('.hidden')).toBe('');
    expect(extensionOf('noext')).toBe('');
    expect(extensionOf('x.')).toBe('.');
  });

  it('recognises exactly the nine', () => {
    for (const type of MEMORY_NINE) expect(isArtifactType(type)).toBe(true);
    for (const type of ['plotly-json', 'svg', 'CSV', '']) expect(isArtifactType(type)).toBe(false);
  });
});
