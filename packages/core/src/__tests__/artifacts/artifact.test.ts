import { describe, expect, it } from 'vitest';
import { describeDiscrepancies } from '../../artifacts/artifact';
import { DEFAULT_TABLE_PAGE_ROWS, FORMULA_SCAN_ROWS, MAX_ARCHIVE_BYTES, MAX_ARTIFACTS_PER_RUN, MAX_ARTIFACT_PREVIEW_BYTES, MAX_TABLE_PAGE_ROWS, MAX_TABLE_SCAN_ROWS } from '../../artifacts/limits';
import { SCRIPT_MAX_OUTPUT_FILES, SCRIPT_MAX_OUTPUT_TOTAL_BYTES } from '../../execution/runtime-limits';

describe('describeDiscrepancies', () => {
  it('is empty when declared, produced, and kept agree', () => {
    expect(describeDiscrepancies({ declaredOutputCount: 3, missingDeclaredCount: 0, undeclaredCount: 0, unregisteredOutputCount: 0 })).toEqual([]);
    expect(describeDiscrepancies({ declaredOutputCount: null, missingDeclaredCount: 0, undeclaredCount: 0, unregisteredOutputCount: null })).toEqual([]);
  });

  it('words each kind of difference, in numbers a person can read', () => {
    const all = describeDiscrepancies({ declaredOutputCount: 3, missingDeclaredCount: 2, undeclaredCount: 1, unregisteredOutputCount: 4 });
    expect(all.map((entry) => [entry.kind, entry.count])).toEqual([['missing', 2], ['undeclared', 1], ['unregistered', 4]]);
    expect(all[0]!.message).toBe('The script said it would produce 3 files, but 2 of them were not written.');
    expect(all[1]!.message).toBe('The script wrote 1 file it did not list. It is kept below and marked.');
    expect(all[2]!.message).toContain('4 files the script wrote could not be kept');
  });

  it('uses the singular for one missing file', () => {
    expect(describeDiscrepancies({ declaredOutputCount: 1, missingDeclaredCount: 1, undeclaredCount: 0, unregisteredOutputCount: 0 })[0]!.message).toBe('The script said it would produce 1 file, but 1 of them was not written.');
  });
});

describe('artifact limits', () => {
  it('aligns the registration and archive caps with FEAT-108 rather than inventing new ones', () => {
    expect(MAX_ARTIFACTS_PER_RUN).toBe(SCRIPT_MAX_OUTPUT_FILES);
    expect(MAX_ARCHIVE_BYTES).toBe(SCRIPT_MAX_OUTPUT_TOTAL_BYTES);
  });

  it('keeps the D12 values', () => {
    expect([MAX_ARTIFACT_PREVIEW_BYTES, DEFAULT_TABLE_PAGE_ROWS, MAX_TABLE_PAGE_ROWS, MAX_TABLE_SCAN_ROWS, FORMULA_SCAN_ROWS]).toEqual([5_242_880, 100, 500, 50_000, 5_000]);
    expect(DEFAULT_TABLE_PAGE_ROWS).toBeLessThanOrEqual(MAX_TABLE_PAGE_ROWS);
  });
});
