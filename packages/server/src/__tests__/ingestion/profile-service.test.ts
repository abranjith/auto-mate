import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createReadStream, existsSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import pino from 'pino';
import { NoTabularContentError, ParseFailedError, ParseTimeoutError, UPLOAD_LIMIT_DEFAULTS } from '@automate/core';
import type { IngestionConfig } from '../../config/env';
import { UploadProfileRepository } from '../../db/repositories/upload-profile-repository';
import { UploadRepository } from '../../db/repositories/upload-repository';
import { ProfileService, type ProfileServiceDependencies } from '../../ingestion/profile-service';
import { UploadFileStore } from '../../ingestion/upload-file-store';
import { SHA, createTempStore, type TempStore } from '../support/ingestion-fixtures';
import { writeStreamingWorkbook } from '../support/workbook-fixtures';

let store: TempStore;
let uploads: UploadRepository;
let profiles: UploadProfileRepository;
let files: UploadFileStore;
const limits: IngestionConfig = { ...UPLOAD_LIMIT_DEFAULTS };

beforeEach(() => {
  store = createTempStore();
  uploads = new UploadRepository(store.connection);
  profiles = new UploadProfileRepository(store.connection);
  files = new UploadFileStore(store.paths);
});
afterEach(() => store.dispose());

function service(overrides: Partial<ProfileServiceDependencies> = {}): ProfileService {
  return new ProfileService({ uploads, profiles, store: files, limits, logger: pino({ level: 'silent' }), ...overrides });
}

/** Put bytes where a staged upload of this format would live and record the row. */
async function stagedFile(content: string | Buffer, format: 'csv' | 'xlsx' = 'csv', write?: (target: string) => Promise<void>) {
  const row = uploads.stage({ originalFilename: `data.${format}`, format, mimeType: 'text/csv', byteSize: 1, sha256: SHA }, (id) => ({
    storedFilename: `${id}-data.${format}`,
    filePath: files.relative(files.stagedPathFor(id, `data.${format}`)),
  }));
  const target = files.absolute(row.filePath);
  const incoming = files.incomingPath();
  if (write) await write(incoming);
  else writeFileSync(incoming, content);
  await files.placeStaged(incoming, row.id, row.storedFilename);
  return { row, target };
}

describe('ProfileService', () => {
  it('profiles a CSV, persists the profile, and records the duration and encoding', async () => {
    const { row } = await stagedFile('id,amount\n1,2.5\n2,3\n');
    const ticks = [100, 142];
    const result = await service({ now: () => ticks.shift() ?? 142 }).profile(row.id);
    expect(result[0]).toMatchObject({ rowCount: 2, columnCount: 2, delimiter: ',' });
    expect(uploads.getById(row.id)).toMatchObject({ profileStatus: 'profiled', profileDurationMs: 42, encoding: 'utf-8' });
    expect(profiles.listByUpload(row.id)).toEqual(result);
  });

  it('times out, marks the upload failed, and destroys the stream it was reading', async () => {
    const rows = Array.from({ length: 300_000 }, (_, index) => `${index},${index % 7},note ${index}`).join('\n');
    const { row } = await stagedFile(`id,amount,note\n${rows}\n`);
    const streams: Readable[] = [];
    const openStream = (target: string) => {
      const stream = createReadStream(target);
      streams.push(stream);
      return stream;
    };
    await expect(service({ limits: { ...limits, parseTimeoutMs: 40 }, openStream }).profile(row.id)).rejects.toBeInstanceOf(ParseTimeoutError);
    expect(uploads.getById(row.id)).toMatchObject({ profileStatus: 'failed', profileErrorCode: 'PARSE_TIMEOUT' });
    expect(uploads.getById(row.id)?.profileErrorMessage).toContain('longer than 40 milliseconds');
    expect(streams.length).toBeGreaterThan(0);
    expect(streams.every((stream) => stream.destroyed)).toBe(true);
    expect(profiles.listByUpload(row.id)).toEqual([]);
  });

  it('marks a parse failure failed with a plain-English message and keeps the stored file', async () => {
    const { row, target } = await stagedFile('id,note\n1,ok\n2,"never closed\n');
    await expect(service().profile(row.id)).rejects.toBeInstanceOf(ParseFailedError);
    expect(uploads.getById(row.id)).toMatchObject({ profileStatus: 'failed', profileErrorCode: 'PARSE_FAILED' });
    expect(uploads.getById(row.id)?.profileErrorMessage).toContain('(line 3)');
    expect(existsSync(target)).toBe(true);
  });

  it('turns an unexpected failure into a generic message that leaks nothing', async () => {
    const { row } = await stagedFile('id\n1\n');
    const broken = () => new Readable({ read() { this.destroy(new Error('EIO: disk exploded at C:\\secret')); } });
    const error = await service({ openStream: broken }).profile(row.id).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ParseFailedError);
    expect((error as Error).message).not.toMatch(/disk exploded|secret/);
    expect(uploads.getById(row.id)?.profileStatus).toBe('failed');
  });

  it('records an empty sheet among populated ones instead of failing the workbook, and notes a sheet cap', async () => {
    const { row } = await stagedFile('', 'xlsx', (target) =>
      writeStreamingWorkbook(target, [
        { name: 'Sales', rows: [['id', 'amount'], [1, 2]] },
        { name: 'Notes', rows: [] },
        { name: 'Extra', rows: [['a', 'b'], [1, 2]] },
      ]),
    );
    const result = await service({ limits: { ...limits, maxSheets: 2 } }).profile(row.id);
    expect(result.map(({ sheetName, rowCount, columnCount }) => [sheetName, rowCount, columnCount])).toEqual([
      ['Sales', 1, 2],
      ['Notes', 0, 0],
    ]);
    expect(result[1]!.notes).toContainEqual({ code: 'empty_sheet' });
    expect(result[0]!.notes).toContainEqual({ code: 'sheet_cap_reached', limit: 2, count: 3 });
    expect(uploads.getById(row.id)).toMatchObject({ profileStatus: 'profiled', encoding: null });
  });

  it('fails a workbook whose every sheet is empty', async () => {
    const { row } = await stagedFile('', 'xlsx', (target) => writeStreamingWorkbook(target, [{ name: 'A', rows: [] }, { name: 'B', rows: [[]] }]));
    await expect(service().profile(row.id)).rejects.toBeInstanceOf(NoTabularContentError);
    expect(uploads.getById(row.id)).toMatchObject({ profileStatus: 'failed', profileErrorCode: 'NO_TABULAR_CONTENT' });
  });

  it('never logs a filename, a cell, or a statistic', async () => {
    const lines: string[] = [];
    const logger = pino({ level: 'debug' }, { write: (line: string) => lines.push(line) });
    const { row } = await stagedFile('customer,amount\nsecret-person,987654\n');
    await service({ logger }).profile(row.id);
    const logged = lines.join('\n');
    expect(logged).toContain('upload profiled');
    expect(logged).not.toMatch(/secret-person|987654|data\.csv|customer/);
  });
});
