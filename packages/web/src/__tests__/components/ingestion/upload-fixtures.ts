// Shared test support for the ingestion component suites. Not a test file.
import type { ColumnProfile, TableProfile, UploadResponse } from '@automate/core';

export function column(overrides: Partial<ColumnProfile> = {}): ColumnProfile {
  return {
    position: 0,
    name: 'amount',
    originalName: null,
    inferredType: 'decimal',
    typeConfidence: 1,
    isMixedType: false,
    nullCount: 1,
    blankCount: 2,
    valueCount: 9,
    distinctCount: 7,
    isHighCardinality: false,
    stats: { kind: 'numeric', min: 0, max: 9812.4, mean: 120.5, stddev: 4, median: 99, p25: 10, p75: 150, approximate: false },
    topValues: [{ value: '99', count: 3 }],
    ...overrides,
  };
}

export function table(overrides: Partial<TableProfile> = {}): TableProfile {
  const columns = overrides.columns ?? [column(), column({ position: 1, name: 'city', inferredType: 'string', stats: { kind: 'string', minLength: 4, maxLength: 9, meanLength: 5.5 }, topValues: [{ value: 'Paris', count: 4 }] })];
  return {
    sheetName: null,
    sheetIndex: 0,
    isHidden: false,
    rowCount: 40118,
    rowCountExact: true,
    columnCount: columns.length,
    hasHeader: true,
    headerRowIndex: 0,
    delimiter: ',',
    dialect: null,
    raggedRowCount: 0,
    blankRowCount: 0,
    mergedCellCount: 0,
    formulaCellCount: 0,
    sampleRows: [
      ['12.5', 'Paris'],
      ['3', 'Oslo'],
    ],
    notes: [],
    columns,
    ...overrides,
  };
}

export function uploadResponse(profiles: TableProfile[] = [table()], overrides: Partial<UploadResponse['upload']> = {}): UploadResponse {
  return {
    upload: {
      id: 1,
      taskId: null,
      originalFilename: 'sales-q3.csv',
      storedFilename: '1-sales-q3.csv',
      filePath: 'uploads/staged/1/1-sales-q3.csv',
      format: 'csv',
      mimeType: 'text/csv',
      byteSize: 2048,
      sha256: 'a'.repeat(64),
      encoding: 'utf-8',
      profileStatus: 'profiled',
      profileError: null,
      profileDurationMs: 10,
      stagedAt: '2026-09-23T00:00:00.000Z',
      attachedAt: null,
      createdAt: '2026-09-23T00:00:00.000Z',
      ...overrides,
    },
    profiles,
    disclosure: null,
  };
}

/** A File whose reported size can be set without allocating it. */
export function fileOf(name: string, size = 10, content = 'a,b\n1,2\n'): File {
  const file = new File([content], name, { type: 'text/csv' });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}
