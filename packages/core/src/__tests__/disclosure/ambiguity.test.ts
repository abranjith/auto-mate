import { describe, expect, it } from 'vitest';
import { classifyFindings } from '../../disclosure/ambiguity';
import type { TableProfile } from '../../contracts/upload-api';

const profile = (sheetIndex: number, notes: TableProfile['notes']): TableProfile => ({
  sheetName: null,
  sheetIndex,
  isHidden: false,
  rowCount: 10,
  rowCountExact: true,
  columnCount: 1,
  hasHeader: true,
  headerRowIndex: 0,
  delimiter: ',',
  dialect: { quoteChar: '"', lineEnding: '\n', hasBom: false, confidence: { quoteChar: 1, lineEnding: 1, delimiter: 1, header: 1 } },
  raggedRowCount: 0,
  blankRowCount: 0,
  mergedCellCount: 0,
  formulaCellCount: 0,
  sampleRows: [],
  notes,
  columns: [{ position: 0, name: 'date', originalName: null, inferredType: 'date', typeConfidence: 0.5, isMixedType: false, nullCount: 0, blankCount: 0, valueCount: 10, distinctCount: 2, isHighCardinality: false, stats: null, topValues: null }],
});

describe('ambiguity classification', () => {
  it('honors the configured cap and demotes the remainder deterministically', () => {
    const findings = classifyFindings([profile(0, [
      { code: 'ragged_rows', count: 1 },
      { code: 'ambiguous_date_format', column: 'date', formats: ['DD/MM', 'MM/DD'] },
    ])], { maxDecisions: 1 });
    expect(findings.required).toHaveLength(1);
    expect(findings.required[0]?.impact).toBe('data_loss');
    expect(findings.defaults.some(({ demoted }) => demoted)).toBe(true);
  });

  it('does not mistake separate single-sheet files for one multi-sheet workbook', () => {
    const findings = classifyFindings([profile(0, []), profile(0, [])]);
    expect(findings.required.some(({ findingKey }) => findingKey.endsWith('multiple_sheets'))).toBe(false);
  });
});
