// FEAT-107 exposed that XLSX fixtures were stamped with the time they were
// written, so a fixture re-derived later never matched its recorded digest and
// every XLSX task would have failed verification's integrity check.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSyntheticFixture, type SyntheticSource } from '@automate/core';
import { normalizeZipTimestamps, writeXlsx, type FixtureSheet } from '../../generation/fixture-writer';
import { openWorkbook } from '../../ingestion/xlsx-reader';

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); });

const source: SyntheticSource = { sheetName: 'Sales', sheetIndex: 0, rowCount: 3, columnCount: 2, hasHeader: true, sampleRows: [['north', '1.5'], ['south', '2.5']], columns: [{ position: 0, name: 'region', inferredType: 'string', isHighCardinality: false, nullCount: 0, blankCount: 0, valueCount: 3, distinctCount: 2, topValues: [{ value: 'north', count: 2 }, { value: 'south', count: 1 }], stats: null }, { position: 1, name: 'amount', inferredType: 'decimal', isHighCardinality: false, nullCount: 0, blankCount: 0, valueCount: 3, distinctCount: 3, topValues: null, stats: null }] } as unknown as SyntheticSource;
const sheet: FixtureSheet = { sheetName: 'Sales', isHidden: false, hasHeader: true, source, table: buildSyntheticFixture(source, { rowCount: 20, seed: 'seed:0' }) };

async function writeAt(when: string): Promise<{ file: string; digest: string }> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(when));
  const dir = mkdtempSync(path.join(tmpdir(), 'automate-xlsx-'));
  dirs.push(dir);
  const file = path.join(dir, 'book.xlsx');
  await writeXlsx(file, [sheet]);
  vi.useRealTimers();
  return { file, digest: createHash('sha256').update(readFileSync(file)).digest('hex') };
}

describe('XLSX fixture determinism', () => {
  it('writes identical bytes for identical content at different times', async () => {
    const first = await writeAt('2026-01-01T00:00:00Z');
    const second = await writeAt('2027-06-15T13:37:42Z');
    expect(second.digest).toBe(first.digest);
  });
  it('still produces a workbook the FEAT-104 reader opens', async () => {
    const { file } = await writeAt('2026-03-03T03:03:03Z');
    const opened = openWorkbook(file, { maxSheets: 5, maxInflatedBytes: 64 * 1024 * 1024 });
    const names: string[] = [];
    try { for await (const table of opened.sheets) { names.push(table.name); for await (const row of table.rows) void row; } } finally { opened.close(); }
    expect(names).toEqual(['Sales']);
  });
  it('leaves a buffer that is not a zip unchanged', () => {
    const text = Buffer.from('not a zip at all, just some bytes that are long enough to scan');
    expect(normalizeZipTimestamps(Buffer.from(text))).toEqual(text);
  });
});
