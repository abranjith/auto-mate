// Shared test support for the ingestion suites. Not a test file: suites import
// it, so it must not register `describe` blocks of its own.
import type {
  ColumnProfile,
  DisclosurePayload,
  TableProfile,
  Upload,
} from '../../contracts/upload-api';

export const SHA = 'a'.repeat(64);

/** A representative integer column. */
export function column(overrides: Partial<ColumnProfile> = {}): ColumnProfile {
  return {
    position: 0,
    name: 'amount',
    originalName: null,
    inferredType: 'integer',
    typeConfidence: 1,
    isMixedType: false,
    nullCount: 0,
    blankCount: 0,
    valueCount: 3,
    distinctCount: 3,
    isHighCardinality: false,
    stats: { kind: 'numeric', min: 1, max: 3, mean: 2, stddev: 1, median: 2, p25: 1.5, p75: 2.5, approximate: false },
    topValues: [{ value: '1', count: 1 }],
    ...overrides,
  };
}

/** A representative single-table CSV profile. */
export function table(overrides: Partial<TableProfile> = {}): TableProfile {
  return {
    sheetName: null,
    sheetIndex: 0,
    isHidden: false,
    rowCount: 3,
    rowCountExact: true,
    columnCount: 1,
    hasHeader: true,
    headerRowIndex: 0,
    delimiter: ',',
    dialect: {
      quoteChar: '"',
      lineEnding: '\n',
      hasBom: false,
      confidence: { delimiter: 1, quoteChar: 1, lineEnding: 1, header: 1 },
    },
    raggedRowCount: 0,
    blankRowCount: 0,
    mergedCellCount: 0,
    formulaCellCount: 0,
    sampleRows: [['1'], ['2'], ['3']],
    notes: [],
    columns: [column()],
    ...overrides,
  };
}

/** A representative stored upload. */
export function upload(overrides: Partial<Upload> = {}): Upload {
  return {
    id: 1,
    taskId: null,
    originalFilename: 'sales.csv',
    storedFilename: '1-sales.csv',
    filePath: 'uploads/staged/1/1-sales.csv',
    format: 'csv',
    mimeType: 'text/csv',
    byteSize: 12,
    sha256: SHA,
    encoding: 'utf-8',
    profileStatus: 'profiled',
    profileError: null,
    profileDurationMs: 4,
    stagedAt: '2026-09-23T00:00:00.000Z',
    attachedAt: null,
    createdAt: '2026-09-23T00:00:00.000Z',
    ...overrides,
  };
}

/** A representative disclosure payload. */
export function payload(overrides: Partial<DisclosurePayload> = {}): DisclosurePayload {
  const { columns, sampleRows, notes, ...rest } = table();
  return {
    version: 1,
    file: { name: 'sales.csv', format: 'csv', byteSize: 12, sha256: SHA, encoding: 'utf-8' },
    tables: [
      {
        sheetName: rest.sheetName,
        sheetIndex: rest.sheetIndex,
        isHidden: rest.isHidden,
        rowCount: rest.rowCount,
        rowCountExact: rest.rowCountExact,
        columnCount: rest.columnCount,
        hasHeader: rest.hasHeader,
        delimiter: rest.delimiter,
        columns: columns.map(({ valueCount: _valueCount, ...kept }) => kept),
        omittedColumnCount: 0,
        sampleRows,
        notes,
      },
    ],
    truncations: [],
    ...overrides,
  };
}
