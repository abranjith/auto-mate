import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { ArtifactIdParamsSchema, ArtifactListResponseSchema, ArtifactPreviewSchema, ArtifactViewSchema, TablePageQuerySchema, TablePageSchema } from '../../contracts/artifact-api';
import { MAX_TABLE_PAGE_ROWS } from '../../artifacts/limits';
import type { ArtifactView } from '../../artifacts/artifact';

const view: ArtifactView = { id: 1, executionId: 2, taskId: 3, scriptRunId: 4, filename: 'résumé.csv', type: 'csv', extension: '.csv', mimeType: 'text/csv; charset=utf-8', renderMode: 'table', declared: false, title: null, description: '<script>', byteSize: 10, sha256: 'a'.repeat(64), contentScan: { scannedRows: 3, rowsAreCapped: false, formulaCellCount: 1, sampledColumns: 2 }, registeredAt: '2026-09-25T00:00:00.000Z', contentUrl: '/api/artifacts/1/content', downloadUrl: '/api/artifacts/1/download' };

describe('artifact API contracts', () => {
  it('round-trips every response shape through JSON unchanged', () => {
    const samples: [Parameters<typeof Value.Check>[0], unknown][] = [
      [ArtifactViewSchema, view],
      [ArtifactListResponseSchema, { executionId: 2, scriptRunId: 4, artifacts: [view], artifactCount: 1, unregisteredOutputCount: 0, declaredOutputCount: 0, producedOutputCount: 1, totalBytes: 10, discrepancies: [{ kind: 'undeclared', count: 1, message: 'x' }], archiveUrl: null }],
      [ArtifactListResponseSchema, { executionId: 2, scriptRunId: null, artifacts: [], artifactCount: null, unregisteredOutputCount: null, declaredOutputCount: null, producedOutputCount: null, totalBytes: 0, discrepancies: [], archiveUrl: null }],
      [TablePageSchema, { columns: ['a'], rows: [['=1']], offset: 0, limit: 100, hasMore: false, scannedRowsCapped: false, truncatedCellCount: 0, sheet: 'Sheet1', otherSheets: ['B'], formulaCellCount: 1 }],
      [ArtifactPreviewSchema, { text: '{}', truncated: false, byteSize: 2, previewBytes: 2 }],
    ];
    for (const [schema, sample] of samples) {
      expect(Value.Check(schema, sample)).toBe(true);
      expect(JSON.parse(JSON.stringify(sample))).toEqual(sample);
    }
  });

  it('has no location field anywhere in an artifact view', () => {
    expect(Object.keys(ArtifactViewSchema.properties).filter((key) => /path|dir|location/i.test(key))).toEqual([]);
  });

  it('accepts only plain positive decimal ids', () => {
    for (const id of ['1', '42', '999999999999999']) expect(Value.Check(ArtifactIdParamsSchema, { id })).toBe(true);
    for (const id of ['0', '-1', '01', '1e3', '1.0', ' 1', 'abc', '']) expect(Value.Check(ArtifactIdParamsSchema, { id })).toBe(false);
  });

  it('bounds a table page request', () => {
    expect(Value.Check(TablePageQuerySchema, { offset: 0, limit: MAX_TABLE_PAGE_ROWS })).toBe(true);
    expect(Value.Check(TablePageQuerySchema, {})).toBe(true);
    expect(Value.Check(TablePageQuerySchema, { limit: 10_000 })).toBe(false);
    expect(Value.Check(TablePageQuerySchema, { limit: 0 })).toBe(false);
    expect(Value.Check(TablePageQuerySchema, { offset: -1 })).toBe(false);
    expect(Value.Check(TablePageQuerySchema, { offset: 1.5 })).toBe(false);
    expect(Value.Check(TablePageQuerySchema, { page: 1 })).toBe(false);
  });

  it('rejects a digest that is not lowercase hex', () => {
    expect(Value.Check(ArtifactViewSchema, { ...view, sha256: 'A'.repeat(64) })).toBe(false);
  });
});
