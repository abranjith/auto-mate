// FEAT-111 TASK-015: the save-and-rerun documentation is checked against the code
// it quotes, so a wording change in `wording.ts` or the mapping renderer fails the
// build instead of leaving the page stale, and no page overstates the four claims.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { COMPATIBILITY_FINDING_CODES, SAVED_TASK_KEEPS, describeCompatibilityFinding, describeCompatibilityStatus, renderMappingInstructions } from '@automate/core';

const repo = path.join(import.meta.dirname, '..', '..', '..', '..', '..');
const read = (...parts: string[]) => readFileSync(path.join(repo, ...parts), 'utf8');
const feature = read('docs', 'features', 'save-and-rerun.md');
const usage = read('docs', 'usage.md');
const route = read('packages', 'server', 'src', 'routes', 'template-route.ts');

describe('docs/features/save-and-rerun.md matches the code', () => {
  it('documents every compatibility message and status in the words wording.ts uses', () => {
    for (const code of COMPATIBILITY_FINDING_CODES) {
      const { headline } = describeCompatibilityFinding({ code, severity: 'info', inputPosition: 0, sheet: null, column: null, expected: null, found: null, suggestion: null });
      expect(feature, code).toContain(headline);
    }
    for (const status of ['compatible', 'compatible_with_warnings', 'incompatible'] as const) expect(feature, status).toContain(describeCompatibilityStatus(status).replace(/\.$/, ''));
  });

  it('quotes the kept-items sentence verbatim', () => {
    expect(feature).toContain(SAVED_TASK_KEEPS);
  });

  it('shows the rendered mapping example exactly as the renderer writes it', () => {
    const rendered = renderMappingInstructions({
      columns: [{ inputPosition: 0, sheet: null, expected: 'Amount', use: 'Total' }, { inputPosition: 0, sheet: null, expected: 'Region', use: null }],
      sheets: [{ inputPosition: 0, expected: 'Sep', use: 'Oct' }],
      decisions: [{ findingKey: '0:Date:ambiguous_date_format', answer: 'DD/MM/YYYY' }],
      note: null,
    }, { version: 1, inputs: [], rules: [], notes: [] });
    expect(feature).toContain(rendered);
  });
});

describe('the API reference covers every saved-task route', () => {
  it('lists each route registered in template-route.ts', () => {
    const routes = [...route.matchAll(/router\.(get|post|delete)\('([^']+)'/g)].map(([, method, url]) => `${method!.toUpperCase()} ${url}`);
    // The spec says "eleven"; TASK-005 to TASK-010 define thirteen, all of which are documented.
    expect(routes).toHaveLength(13);
    for (const entry of routes) expect(usage, entry).toContain(entry.replace(/\?.*$/, ''));
  });
});

describe('no document overstates what FEAT-111 delivers', () => {
  const pages = [feature, usage, read('docs', 'architecture.md'), read('CHANGELOG.md')];
  it('never calls the fit check a guarantee, replay bit-for-bit, or a saved task free of the person\'s data', () => {
    for (const page of pages) {
      for (const sentence of page.split(/(?<=[.!?])\s+/)) {
        const negated = /\b(not|no|never|without|nothing|cannot|doesn't|does not|isn't)\b/i.test(sentence);
        if (/guarantee/i.test(sentence) && /(compatib|fit check)/i.test(sentence)) expect(negated, sentence).toBe(true);
        if (/bit-for-bit/i.test(sentence)) expect(negated, sentence).toBe(true);
        if (/free of (your|the person's) data/i.test(sentence)) expect(negated, sentence).toBe(true);
      }
    }
    expect(feature).toMatch(/shape and recorded choices\*\*, not the meaning/);
    expect(feature).toMatch(/does not promise bit-for-bit/);
  });
  it('names FEAT-111 in the changelog', () => {
    expect(read('CHANGELOG.md')).toContain('FEAT-111');
  });
});
