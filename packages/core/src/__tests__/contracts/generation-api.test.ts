import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_TYPES,
  CodeFileSchema,
  CodeVersionDetailSchema,
  CodeVersionSummarySchema,
  FinalizeScriptArgsSchema,
  GenerationAttemptSchema,
  RetryRequestSchema,
  RunTestsArgsSchema,
  SyntheticFixtureSchema,
  WriteScriptArgsSchema,
  WriteTestArgsSchema,
} from '../../contracts/generation-api';
import { MAX_GUIDANCE_CHARS } from '../../generation/limits';

const digest = 'a'.repeat(64);
const file = { path: 'main.py', role: 'script', byteSize: 9, lineCount: 1, sha256: digest };
const summary = { id: 1, executionId: 2, attempt: 1, status: 'tested_fail', contentDigest: digest, entrypoint: 'main.py', isFinal: false, testsPassed: false, summary: null, sealedAt: '2026-09-24T00:00:00.000Z', createdAt: '2026-09-24T00:00:00.000Z', files: [file] };
const finalize = { entrypoint: 'main.py', summary: 'Totals sales by region.', declaredInputs: [{ fileRole: 'sales.csv', requiredColumns: [{ name: 'region', type: 'string' }] }], declaredOutputs: [{ filename: 'totals.csv', type: 'csv', title: 'Totals', description: 'Sales per region.' }] };

const valid: readonly [string, object, unknown][] = [
  ['CodeFileSchema', CodeFileSchema, { ...file, content: 'print(1)\n' }],
  ['CodeVersionSummarySchema', CodeVersionSummarySchema, summary],
  ['CodeVersionSummarySchema (draft)', CodeVersionSummarySchema, { ...summary, status: 'draft', contentDigest: null, sealedAt: null, testsPassed: null, files: [] }],
  ['CodeVersionDetailSchema', CodeVersionDetailSchema, { ...summary, isFinal: true, summary: 'Totals', files: [{ ...file, content: 'print(1)\n' }], declaredInputs: finalize.declaredInputs, declaredOutputs: finalize.declaredOutputs }],
  ['GenerationAttemptSchema', GenerationAttemptSchema, { id: 1, executionId: 2, codeVersionId: 1, attempt: 1, status: 'failed', refusalReason: null, testsTotal: 3, testsPassed: 2, testsFailed: 1, exitCode: 1, manifestPresent: false, diagnosticDigest: digest, droppedLineCount: 14, durationMs: 812, startedAt: '2026-09-24T00:00:00.000Z', settledAt: '2026-09-24T00:00:01.000Z', diagnostics: 'ValueError: <str len=3>' }],
  ['GenerationAttemptSchema (refused)', GenerationAttemptSchema, { id: 2, executionId: 2, codeVersionId: null, attempt: 4, status: 'refused', refusalReason: 'attempt_limit', testsTotal: null, testsPassed: null, testsFailed: null, exitCode: null, manifestPresent: null, diagnosticDigest: null, droppedLineCount: null, durationMs: null, startedAt: '2026-09-24T00:00:00.000Z', settledAt: '2026-09-24T00:00:00.000Z', diagnostics: null }],
  ['SyntheticFixtureSchema', SyntheticFixtureSchema, { id: 1, executionId: 2, uploadId: 3, fileName: 'sales.csv', format: 'csv', sheetCount: 1, rowCount: 200, sampleRowCount: 10, byteSize: 4096, sha256: digest, seed: '0123456789abcdef', createdAt: '2026-09-24T00:00:00.000Z', preview: [{ sheetName: null, header: ['region'], rows: [['North']] }] }],
  ['RetryRequestSchema', RetryRequestSchema, { guidance: 'Group by month, not by day.' }],
  ['RetryRequestSchema (empty)', RetryRequestSchema, {}],
  ['WriteScriptArgsSchema', WriteScriptArgsSchema, { path: 'main.py', content: 'print(1)\n' }],
  ['WriteTestArgsSchema', WriteTestArgsSchema, { path: 'test_main.py', content: 'def test_x():\n    pass\n' }],
  ['RunTestsArgsSchema', RunTestsArgsSchema, {}],
  ['FinalizeScriptArgsSchema', FinalizeScriptArgsSchema, finalize],
];

describe('generation wire contracts', () => {
  it.each(valid)('%s accepts a representative value that survives a JSON round trip unchanged', (_name, schema, value) => {
    expect(Value.Check(schema as never, value)).toBe(true);
    expect(JSON.parse(JSON.stringify(value))).toEqual(value);
  });

  it('closes the tool parameter schemas: a missing field or an extra property is rejected', () => {
    expect(Value.Check(WriteScriptArgsSchema, { content: 'x' })).toBe(false);
    expect(Value.Check(WriteScriptArgsSchema, { path: 'main.py' })).toBe(false);
    expect(Value.Check(WriteScriptArgsSchema, { path: 'main.py', content: 'x', mode: 'append' })).toBe(false);
    expect(Value.Check(WriteTestArgsSchema, { path: '', content: 'x' })).toBe(false);
    expect(Value.Check(RunTestsArgsSchema, { path: 'anything' })).toBe(false);
    expect(Value.Check(FinalizeScriptArgsSchema, { ...finalize, extra: true })).toBe(false);
  });

  it('rejects a declared output type FEAT-109 cannot render, at the schema', () => {
    for (const type of ARTIFACT_TYPES) expect(Value.Check(FinalizeScriptArgsSchema, { ...finalize, declaredOutputs: [{ ...finalize.declaredOutputs[0]!, type }] })).toBe(true);
    for (const type of ['svg', 'exe', 'plotly-json', 'shell']) expect(Value.Check(FinalizeScriptArgsSchema, { ...finalize, declaredOutputs: [{ ...finalize.declaredOutputs[0]!, type }] })).toBe(false);
  });

  it('rejects declared input columns typed outside the profile vocabulary', () => {
    expect(Value.Check(FinalizeScriptArgsSchema, { ...finalize, declaredInputs: [{ fileRole: 'a.csv', requiredColumns: [{ name: 'x', type: 'number' }] }] })).toBe(false);
  });

  it('caps retry guidance at the documented length', () => {
    expect(Value.Check(RetryRequestSchema, { guidance: 'x'.repeat(MAX_GUIDANCE_CHARS) })).toBe(true);
    expect(Value.Check(RetryRequestSchema, { guidance: 'x'.repeat(MAX_GUIDANCE_CHARS + 1) })).toBe(false);
    expect(Value.Check(RetryRequestSchema, { guidance: 'x', other: 1 })).toBe(false);
  });

  it('has no schema field capable of naming an absolute path or a fixture directory', () => {
    const keys = JSON.stringify([CodeFileSchema, CodeVersionDetailSchema, GenerationAttemptSchema, SyntheticFixtureSchema]);
    expect(keys).not.toMatch(/"(?:filePath|absolutePath|dirPath|workingDir)"/);
  });
});
