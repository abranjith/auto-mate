import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import type { TSchema } from '@sinclair/typebox';
import {
  ColumnProfileSchema,
  DisclosurePayloadSchema,
  TableProfileSchema,
  UploadListResponseSchema,
  UploadResponseSchema,
  UploadSchema,
} from '../../contracts/upload-api';
import * as barrel from '../../index';
import { column, payload, table, upload } from '../ingestion/profile-fixtures';

/** Collect every property name declared anywhere inside a schema. */
function propertyNames(schema: unknown, names = new Set<string>()): Set<string> {
  if (!schema || typeof schema !== 'object') return names;
  const node = schema as Record<string, unknown>;
  if (node.properties && typeof node.properties === 'object') {
    for (const [name, child] of Object.entries(node.properties as Record<string, unknown>)) {
      names.add(name);
      propertyNames(child, names);
    }
  }
  for (const key of ['items', 'anyOf', 'allOf', 'oneOf']) {
    const child = node[key];
    if (Array.isArray(child)) child.forEach((item) => propertyNames(item, names));
    else propertyNames(child, names);
  }
  return names;
}

const without = (value: Record<string, unknown>, key: string) => {
  const copy = { ...value };
  delete copy[key];
  return copy;
};

describe('upload contracts', () => {
  const response = { upload: upload(), profiles: [table()], disclosure: payload() };

  it.each<[string, TSchema, Record<string, unknown>, string]>([
    ['column', ColumnProfileSchema, column(), 'inferredType'],
    ['table', TableProfileSchema, table(), 'rowCountExact'],
    ['upload', UploadSchema, upload(), 'sha256'],
    ['disclosure', DisclosurePayloadSchema, payload(), 'truncations'],
    ['response', UploadResponseSchema, response, 'profiles'],
  ])('%s schema accepts a valid payload and rejects a missing field', (_name, schema, valid, required) => {
    expect(Value.Errors(schema, valid).First()).toBeUndefined();
    expect(Value.Check(schema, without(valid, required))).toBe(false);
  });

  it('accepts a list of up to five uploads and nothing more', () => {
    expect(Value.Check(UploadListResponseSchema, { uploads: [] })).toBe(true);
    expect(Value.Check(UploadListResponseSchema, { uploads: Array(5).fill(response) })).toBe(true);
    expect(Value.Check(UploadListResponseSchema, { uploads: Array(6).fill(response) })).toBe(false);
  });

  it('schema-enforces the sample cell and sample row caps on the disclosure payload', () => {
    const base = payload();
    const withRows = (rows: string[][]) => ({ ...base, tables: [{ ...base.tables[0]!, sampleRows: rows }] });
    expect(Value.Check(DisclosurePayloadSchema, withRows([['x'.repeat(200)]]))).toBe(true);
    expect(Value.Check(DisclosurePayloadSchema, withRows([['x'.repeat(201)]]))).toBe(false);
    expect(Value.Check(DisclosurePayloadSchema, withRows(Array(10).fill(['1'])))).toBe(true);
    expect(Value.Check(DisclosurePayloadSchema, withRows(Array(11).fill(['1'])))).toBe(false);
  });

  it('caps frequent values at five and requires a hex SHA-256', () => {
    const tooMany = column({ topValues: Array.from({ length: 6 }, (_, index) => ({ value: String(index), count: 1 })) });
    expect(Value.Check(ColumnProfileSchema, tooMany)).toBe(false);
    expect(Value.Check(UploadSchema, upload({ sha256: 'A'.repeat(64) }))).toBe(false);
    expect(Value.Check(UploadSchema, upload({ sha256: 'a'.repeat(63) }))).toBe(false);
  });

  it('rejects a type confidence outside 0..1 and an unknown inferred type', () => {
    expect(Value.Check(ColumnProfileSchema, column({ typeConfidence: 1.01 }))).toBe(false);
    expect(Value.Check(ColumnProfileSchema, { ...column(), inferredType: 'currency' })).toBe(false);
  });

  it('gives an upload response no property capable of carrying an absolute path', () => {
    const pathLike = [...propertyNames(UploadResponseSchema)].filter((name) => /path|dir|root|location/i.test(name));
    expect(pathLike).toEqual(['filePath']);
  });

  it.each(['/etc/passwd', 'C:\\Users\\me\\x.csv', 'c:/x.csv', '\\\\server\\share\\x.csv', 'uploads/../../x.csv', '..\\x.csv', '..'])(
    'rejects the non-relative file path %s',
    (filePath) => expect(Value.Check(UploadSchema, upload({ filePath }))).toBe(false),
  );

  it.each(['uploads/staged/1/1-a.csv', 'uploads\\7\\3-b.xlsx', 'uploads/7/3-..weird.csv'])(
    'accepts the relative file path %s',
    (filePath) => expect(Value.Check(UploadSchema, upload({ filePath }))).toBe(true),
  );

  it('survives a JSON round trip unchanged', () => {
    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
  });

  it('is importable from the package barrel', () => {
    expect(barrel.UploadResponseSchema).toBe(UploadResponseSchema);
    expect(barrel.DisclosurePayloadSchema).toBe(DisclosurePayloadSchema);
    expect(barrel.DISCLOSURE_MAX_BYTES).toBe(65_536);
    expect(barrel.SAMPLE_ROW_COUNT).toBe(10);
    expect(barrel.SAMPLE_CELL_MAX_CHARS).toBe(200);
  });
});
