import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { parse } from 'csv-parse/sync';
import { FixtureGenerationError, type TableProfile } from '@automate/core';
import { FixtureService, fixtureSeed } from '../../generation/fixture-service';
import { typedCell } from '../../generation/fixture-writer';
import { SyntheticFixtureRepository } from '../../db/repositories/synthetic-fixture-repository';
import { UploadProfileRepository } from '../../db/repositories/upload-profile-repository';
import { UploadRepository } from '../../db/repositories/upload-repository';
import { TaskRepository } from '../../db/repositories/task-repository';
import { openWorkbook } from '../../ingestion/xlsx-reader';
import { createTempStore, columnProfile, type TempStore } from '../support/ingestion-fixtures';
import { HIGH_CARDINALITY_SENTINEL, ROW_11_SENTINEL, sentinelCsv, stageProfiledUpload } from '../support/generation-fixtures';
import { writeStreamingWorkbook } from '../support/workbook-fixtures';

let store: TempStore;
let executionId: number;
beforeEach(() => {
  store = createTempStore('automate-fixture-');
  executionId = new TaskRepository(store.connection).createWithExecution('Summarize').execution.id;
});
afterEach(() => store.dispose());

function service(rowCount?: number) {
  return new FixtureService({ uploads: new UploadRepository(store.connection), profiles: new UploadProfileRepository(store.connection), fixtures: new SyntheticFixtureRepository(store.connection), paths: store.paths, logger: pino({ level: 'silent' }), ...(rowCount ? { rowCount } : {}) });
}
const signal = () => new AbortController().signal;
const fixtureFiles = () => { const dir = path.join(store.paths.scriptsDir, String(executionId), 'fixtures'); return readdirSync(dir).map((name) => path.join(dir, name)); };
/** Insert an upload row plus hand-written profiles, without any file. */
function profiledRow(storedFilename: string, profiles: TableProfile[], format: 'csv' | 'xlsx' = 'csv', encoding: string | null = 'utf-8') {
  const uploads = new UploadRepository(store.connection);
  const row = uploads.createStaged({ originalFilename: 'Real Name.csv', storedFilename, filePath: `uploads/staged/1/${storedFilename}`, format, mimeType: 'text/csv', byteSize: 10, sha256: 'd'.repeat(64) });
  new UploadProfileRepository(store.connection).insertProfiles(row.id, profiles);
  uploads.markProfiled(row.id, { encoding, durationMs: 1 });
  return uploads.getById(row.id)!;
}
const csvTable = (overrides: Partial<TableProfile> = {}): TableProfile => ({ sheetName: null, sheetIndex: 0, isHidden: false, rowCount: 3, rowCountExact: true, columnCount: 2, hasHeader: true, headerRowIndex: 0, delimiter: ',', dialect: { quoteChar: '"', lineEnding: '\n', hasBom: false, confidence: { delimiter: 1, quoteChar: 1, lineEnding: 1, header: 1 } }, raggedRowCount: 0, blankRowCount: 0, mergedCellCount: 0, formulaCellCount: 0, sampleRows: [['1', 'a;b'], ['2', 'plain']], notes: [], columns: [columnProfile({ position: 0, name: 'id' }), columnProfile({ position: 1, name: 'label', inferredType: 'string', stats: { kind: 'string', minLength: 1, maxLength: 8, meanLength: 4 }, topValues: null, isHighCardinality: true, distinctCount: null })], ...overrides });

describe('FixtureService', () => {
  it('writes one CSV named like the upload: header, the 10 sample rows verbatim, then synthesized rows to the row count', async () => {
    const upload = await stageProfiledUpload(store.connection, store.paths, { name: 'sales.csv', bytes: Buffer.from(sentinelCsv()), format: 'csv' });
    const [row] = await service().materializeFixtures(executionId, [upload.id], signal());
    expect(row).toMatchObject({ executionId, uploadId: upload.id, format: 'csv', sheetCount: 1, rowCount: 200, sampleRowCount: 10, filePath: `scripts/${executionId}/fixtures/${upload.storedFilename}`, seed: fixtureSeed(upload.sha256, executionId) });
    const file = path.join(store.paths.scriptsDir, String(executionId), 'fixtures', upload.storedFilename);
    const bytes = readFileSync(file);
    expect(row!.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(row!.byteSize).toBe(bytes.length);
    const records = parse(bytes.toString('utf8')) as string[][];
    expect(records[0]).toEqual(['order_id', 'region', 'amount', 'ref']);
    expect(records.slice(1, 11).map((record) => record[0])).toEqual(Array.from({ length: 10 }, (_, index) => String(1001 + index)));
    expect(records).toHaveLength(201);
  });

  it('is byte-identical when run twice for the same execution', async () => {
    const upload = await stageProfiledUpload(store.connection, store.paths, { name: 'sales.csv', bytes: Buffer.from(sentinelCsv()), format: 'csv' });
    const first = await service().materializeFixtures(executionId, [upload.id], signal());
    const bytes = readFileSync(fixtureFiles()[0]!);
    const second = await service().materializeFixtures(executionId, [upload.id], signal());
    expect(second[0]!.sha256).toBe(first[0]!.sha256);
    expect(readFileSync(fixtureFiles()[0]!).equals(bytes)).toBe(true);
    expect(new SyntheticFixtureRepository(store.connection).listByExecution(executionId)).toHaveLength(1);
  });

  it('never writes a byte of row 11 or of the high-cardinality column the disclosure excludes (the central test)', async () => {
    const real = Buffer.from(sentinelCsv());
    expect(real.includes(ROW_11_SENTINEL)).toBe(true);
    expect(real.includes(HIGH_CARDINALITY_SENTINEL)).toBe(true);
    const upload = await stageProfiledUpload(store.connection, store.paths, { name: 'sales.csv', bytes: real, format: 'csv' });
    await service(2_000).materializeFixtures(executionId, [upload.id], signal());
    for (const file of fixtureFiles()) {
      const bytes = readFileSync(file);
      expect(bytes.includes(ROW_11_SENTINEL)).toBe(false);
      expect(bytes.includes(HIGH_CARDINALITY_SENTINEL)).toBe(false);
    }
  });

  it('writes the real file\'s dialect: a semicolon, CRLF, BOM profile round-trips through a parser with that dialect', async () => {
    const dialect = { quoteChar: '"', lineEnding: '\r\n' as const, hasBom: true, confidence: { delimiter: 1, quoteChar: 1, lineEnding: 1, header: 1 } };
    const upload = profiledRow('7-semi.csv', [csvTable({ delimiter: ';', dialect })]);
    await service(5).materializeFixtures(executionId, [upload.id], signal());
    const bytes = readFileSync(fixtureFiles()[0]!);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = bytes.toString('utf8').slice(1);
    expect(text).toContain('\r\n');
    const records = parse(text, { delimiter: ';', record_delimiter: '\r\n' }) as string[][];
    expect(records.slice(0, 3)).toEqual([['id', 'label'], ['1', 'a;b'], ['2', 'plain']]);
    expect(records).toHaveLength(6);
  });

  it('encodes the fixture the way the real file is encoded', async () => {
    const upload = profiledRow('8-latin.csv', [csvTable({ sampleRows: [['1', 'Zoë €5']] })], 'csv', 'windows-1252');
    await service(1).materializeFixtures(executionId, [upload.id], signal());
    const bytes = readFileSync(fixtureFiles()[0]!);
    expect(bytes.includes(Buffer.from([0x5a, 0x6f, 0xeb, 0x20, 0x80, 0x35]))).toBe(true);
  });

  it('writes a three-sheet workbook as one XLSX with its sheets in order, readable by the FEAT-104 streaming reader', async () => {
    const workbook = path.join(store.root, 'book.xlsx');
    await writeStreamingWorkbook(workbook, [
      { name: 'Orders', rows: [['id', 'total'], ...Array.from({ length: 12 }, (_, index) => [index + 1, index * 2.5])] },
      { name: 'Regions', rows: [['region', 'count'], ['North', 4], ['South', 7]] },
      // Text only: a native date column currently cannot be profiled (FEAT-104 defect, see TODO.md).
      { name: 'Notes', rows: [['note', 'score'], ['first', 1.5], ['second', 2.5]] },
    ]);
    const upload = await stageProfiledUpload(store.connection, store.paths, { name: 'book.xlsx', bytes: readFileSync(workbook), format: 'xlsx' });
    const [row] = await service(20).materializeFixtures(executionId, [upload.id], signal());
    expect(row).toMatchObject({ format: 'xlsx', sheetCount: 3 });
    const file = fixtureFiles()[0]!;
    expect(path.basename(file)).toBe(upload.storedFilename);
    const opened = openWorkbook(file, { maxSheets: 20, maxInflatedBytes: 1024 * 1024 * 1024 });
    const seen: { name: string; header: string[]; rows: number }[] = [];
    try {
      for await (const sheet of opened.sheets) {
        let rows = 0;
        for await (const row of sheet.rows) rows += row.length >= 0 ? 1 : 0;
        seen.push({ name: sheet.name, header: (sheet.header ?? []).map(String), rows });
      }
    } finally { opened.close(); }
    expect(seen).toEqual([{ name: 'Orders', header: ['id', 'total'], rows: 20 }, { name: 'Regions', header: ['region', 'count'], rows: 20 }, { name: 'Notes', header: ['note', 'score'], rows: 20 }]);
  });

  it('types workbook cells the way the profile saw them: numbers, booleans, and native dates', () => {
    const numeric = columnProfile();
    const flag = columnProfile({ inferredType: 'boolean', stats: null });
    const native = columnProfile({ inferredType: 'datetime', stats: { kind: 'temporal', min: '2026-01-01', max: '2026-02-01', detectedFormat: 'excel-native', ambiguous: false, alternateFormat: null } });
    const text = columnProfile({ inferredType: 'date', stats: { kind: 'temporal', min: '2026-01-01', max: '2026-02-01', detectedFormat: 'DD/MM/YYYY', ambiguous: false, alternateFormat: null } });
    expect(typedCell('42', numeric)).toBe(42);
    expect(typedCell('0012', numeric)).toBe('0012');
    expect(typedCell('TRUE', flag)).toBe(true);
    expect(typedCell('2026-01-03', native)).toEqual(new Date(Date.UTC(2026, 0, 3)));
    expect(typedCell('2026-01-03T10:00:00', native)).toEqual(new Date(Date.UTC(2026, 0, 3, 10)));
    expect(typedCell('03/01/2026', text)).toBe('03/01/2026');
    expect(typedCell('', numeric)).toBeNull();
    expect(typedCell('x', undefined)).toBe('x');
  });

  it('raises a position-named error for a failed profile, without the filename or any absolute path', async () => {
    const uploads = new UploadRepository(store.connection);
    const row = uploads.createStaged({ originalFilename: 'Secret Payroll.csv', storedFilename: '9-secret-payroll.csv', filePath: 'uploads/staged/9/secret-payroll.csv', format: 'csv', mimeType: 'text/csv', byteSize: 1, sha256: 'e'.repeat(64) });
    uploads.markFailed(row.id, { code: 'PARSE_FAILED', message: 'bad' });
    const good = profiledRow('10-ok.csv', [csvTable()]);
    const error = await service().materializeFixtures(executionId, [good.id, row.id], signal()).catch((cause: unknown) => cause) as FixtureGenerationError;
    expect(error).toBeInstanceOf(FixtureGenerationError);
    expect(error.message).toBe('File 2 could not be turned into test data because its analysis did not finish.');
    expect(error.message).not.toMatch(/Payroll|payroll/);
    expect(error.message).not.toContain(os.tmpdir());
  });

  it('cannot be steered outside the fixtures directory by a stored filename', async () => {
    const upload = profiledRow('..\\evil.py', [csvTable()]);
    const outcome = await service(3).materializeFixtures(executionId, [upload.id], signal()).then(() => 'written', (cause: unknown) => (cause as Error).message);
    const outside = path.join(store.paths.scriptsDir, String(executionId), 'evil.py');
    expect(existsSync(outside)).toBe(false);
    if (outcome === 'written') expect(fixtureFiles().every((file) => path.dirname(file) === path.join(store.paths.scriptsDir, String(executionId), 'fixtures'))).toBe(true);
    else expect(outcome).toMatch(/outside the application directory/);
  });

  it('clears the fixtures directory first, so a stale file disappears', async () => {
    const upload = profiledRow('11-a.csv', [csvTable()]);
    await service(3).materializeFixtures(executionId, [upload.id], signal());
    const stale = path.join(store.paths.scriptsDir, String(executionId), 'fixtures', 'stale.csv');
    writeFileSync(stale, 'old');
    await service(3).materializeFixtures(executionId, [upload.id], signal());
    expect(existsSync(stale)).toBe(false);
  });

  it('stops between files when cancelled', async () => {
    const upload = profiledRow('12-a.csv', [csvTable()]);
    const controller = new AbortController();
    controller.abort();
    await expect(service().materializeFixtures(executionId, [upload.id], controller.signal)).rejects.toThrow();
  });
});
