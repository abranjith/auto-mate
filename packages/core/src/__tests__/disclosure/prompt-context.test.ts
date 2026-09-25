import { describe, expect, it } from 'vitest';
import { assemblePromptContext, renderDisclosureText } from '../../disclosure/index';
import type { DisclosurePayload } from '../../contracts/upload-api';

const payload: DisclosurePayload = { version: 1, file: { name: 'sales.csv', format: 'csv', byteSize: 12, sha256: 'a'.repeat(64), encoding: 'utf-8' }, tables: [{ sheetName: null, sheetIndex: 0, isHidden: false, rowCount: 1, rowCountExact: true, columnCount: 1, hasHeader: true, delimiter: ',', columns: [{ position: 0, name: 'amount', originalName: null, inferredType: 'integer', typeConfidence: 1, isMixedType: false, nullCount: 0, blankCount: 0, distinctCount: 1, isHighCardinality: false, stats: null, topValues: null }], omittedColumnCount: 0, sampleRows: [['a\nb\t|']], notes: [] }], truncations: [] };

describe('disclosure rendering and prompt context', () => {
  it('renders deterministically without allowing cells to break the table', () => {
    const text = renderDisclosureText([payload]);
    expect(renderDisclosureText([payload])).toBe(text);
    expect(text).toContain('a\\nb\\t\\|');
    expect(text).toContain('Omissions: none.');
  });

  it('assembles sources in a fixed provenance order', () => {
    const result = assemblePromptContext({ userPrompt: 'sum', disclosure: { text: 'approved', consentId: 1 }, diagnostics: { text: 'filtered', consentId: 1 }, appText: ['choice'] });
    expect(result.sources).toEqual(['user_prompt', 'approved_disclosure', 'filtered_diagnostics', 'application_text']);
    expect(result.text.indexOf('sum')).toBeLessThan(result.text.indexOf('approved'));
    expect(result.text.indexOf('approved')).toBeLessThan(result.text.indexOf('filtered'));
  });

  it('rejects an authorization-free disclosure source', () => {
    expect(() => assemblePromptContext({ userPrompt: 'x', disclosure: { text: 'secret', consentId: Number.NaN } })).toThrow(/consent id/i);
  });
});
