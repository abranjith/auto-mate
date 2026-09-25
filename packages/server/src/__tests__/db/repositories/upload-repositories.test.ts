import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RepositoryError, UploadAlreadyAttachedError, UploadNotFoundError } from '@automate/core';
import { TaskRepository } from '../../../db/repositories/task-repository';
import { UploadProfileRepository } from '../../../db/repositories/upload-profile-repository';
import { UploadRepository, type NewStagedUpload } from '../../../db/repositories/upload-repository';
import { SHA, columnProfile, createTempStore, tableProfile, type TempStore } from '../../support/ingestion-fixtures';

let store: TempStore;
let clock: Date;
let uploads: UploadRepository;
let profiles: UploadProfileRepository;
let tasks: TaskRepository;

const staged = (overrides: Partial<NewStagedUpload> = {}): NewStagedUpload => ({
  originalFilename: 'données été 東京.csv',
  storedFilename: '1-donn-es-t.csv',
  filePath: 'uploads/staged/1/1-donn-es-t.csv',
  format: 'csv',
  mimeType: 'text/csv',
  byteSize: 42,
  sha256: SHA,
  ...overrides,
});
const count = (table: string) => (store.connection.client.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count;

beforeEach(() => {
  store = createTempStore();
  clock = new Date('2026-09-23T12:00:00Z');
  uploads = new UploadRepository(store.connection, () => clock);
  profiles = new UploadProfileRepository(store.connection);
  tasks = new TaskRepository(store.connection);
});
afterEach(() => store.dispose());

describe('UploadRepository', () => {
  it('round-trips a unicode filename and a 64-character SHA-256, staged and unattached', () => {
    const row = uploads.createStaged(staged());
    expect(uploads.getById(row.id)).toMatchObject({
      originalFilename: 'données été 東京.csv',
      sha256: SHA,
      taskId: null,
      attachedAt: null,
      profileStatus: 'pending',
      stagedAt: clock,
    });
  });

  it('attaches to a task, setting task, time, and path, and refuses a second attach', () => {
    const task = tasks.create({ name: 'A', description: 'A' });
    const row = uploads.createStaged(staged());
    clock = new Date('2026-09-23T12:05:00Z');
    const attached = uploads.attachToTask(row.id, task.id, 'uploads/1/1-x.csv');
    expect(attached).toMatchObject({ taskId: task.id, filePath: 'uploads/1/1-x.csv', attachedAt: clock });
    expect(() => uploads.attachToTask(row.id, task.id, 'uploads/1/1-x.csv')).toThrow(UploadAlreadyAttachedError);
    expect(() => uploads.attachToTask(999, task.id, 'x')).toThrow(UploadNotFoundError);
  });

  it('lists only unattached uploads staged before the cutoff', () => {
    const task = tasks.create({ name: 'A', description: 'A' });
    clock = new Date('2026-09-20T00:00:00Z');
    const old = uploads.createStaged(staged());
    const oldAttached = uploads.createStaged(staged());
    uploads.attachToTask(oldAttached.id, task.id, 'uploads/1/x.csv');
    clock = new Date('2026-09-23T00:00:00Z');
    uploads.createStaged(staged());
    expect(uploads.listStagedBefore(new Date('2026-09-22T00:00:00Z')).map(({ id }) => id)).toEqual([old.id]);
  });

  it('lists a task\'s uploads in insertion order', () => {
    const task = tasks.create({ name: 'A', description: 'A' });
    const ids = [1, 2, 3].map(() => uploads.createStaged(staged()).id);
    [...ids].reverse().forEach((id) => uploads.attachToTask(id, task.id, `uploads/${task.id}/${id}.csv`));
    expect(uploads.listByTask(task.id).map(({ id }) => id)).toEqual(ids);
  });

  it('records the profiling lifecycle, including a failure with no profile rows', () => {
    const row = uploads.createStaged(staged());
    expect(uploads.markProfiling(row.id).profileStatus).toBe('profiling');
    const failed = uploads.markFailed(row.id, { code: 'PARSE_FAILED', message: 'This file could not be read (line 4).', durationMs: 12.6 });
    expect(failed).toMatchObject({ profileStatus: 'failed', profileErrorCode: 'PARSE_FAILED', profileErrorMessage: 'This file could not be read (line 4).', profileDurationMs: 13 });
    expect(profiles.listByUpload(row.id)).toEqual([]);
    const profiled = uploads.markProfiled(row.id, { encoding: 'utf-8', durationMs: 40 });
    expect(profiled).toMatchObject({ profileStatus: 'profiled', encoding: 'utf-8', profileDurationMs: 40, profileErrorCode: 'PARSE_FAILED' });
    expect(uploads.markProfiling(row.id)).toMatchObject({ profileErrorCode: null, profileErrorMessage: null });
    expect(() => uploads.markProfiling(999)).toThrow(UploadNotFoundError);
  });

  it('deletes a row and reports whether one existed', () => {
    const row = uploads.createStaged(staged());
    expect(uploads.deleteById(row.id)).toBe(true);
    expect(uploads.deleteById(row.id)).toBe(false);
  });

  it('rejects a format or size the schema does not allow', () => {
    expect(() => uploads.createStaged(staged({ format: 'xls' as never }))).toThrow(RepositoryError);
    expect(() => uploads.createStaged(staged({ byteSize: -1 }))).toThrow(RepositoryError);
  });
});

describe('UploadProfileRepository', () => {
  it('writes a profile and twelve columns atomically and reads them back identically', () => {
    const row = uploads.createStaged(staged());
    const profile = tableProfile({}, 12);
    profiles.insertProfile(row.id, profile);
    expect(count('upload_column')).toBe(12);
    expect(profiles.listByUpload(row.id)).toEqual([profile]);
  });

  it('rolls back entirely when one column insert fails, leaving no profile row', () => {
    const row = uploads.createStaged(staged());
    const profile = tableProfile({}, 12);
    profile.columns[11] = columnProfile({ position: 11, typeConfidence: 1.5 });
    expect(() => profiles.insertProfile(row.id, profile)).toThrow(RepositoryError);
    expect(count('upload_profile')).toBe(0);
    expect(count('upload_column')).toBe(0);
  });

  it.each([
    ['a distinct count', { distinctCount: 3, topValues: null }],
    ['frequent values', { distinctCount: null, topValues: [{ value: 'secret', count: 2 }] }],
    ['both', { distinctCount: 3, topValues: [{ value: 'secret', count: 2 }] }],
  ])('rejects a high-cardinality column carrying %s', (_label, leak) => {
    const row = uploads.createStaged(staged());
    const profile = tableProfile({ columns: [columnProfile({ isHighCardinality: true, ...leak })] });
    expect(() => profiles.insertProfile(row.id, profile)).toThrow(/privacy rule/);
    expect(count('upload_profile')).toBe(0);
  });

  it('enforces the same invariant in the database itself', () => {
    const row = uploads.createStaged(staged());
    const profileId = profiles.insertProfile(row.id, tableProfile({ columns: [] }));
    const insert = store.connection.client.prepare(
      "INSERT INTO upload_column (profile_id, position, name, inferred_type, type_confidence, is_high_cardinality, distinct_count) VALUES (?, 0, 'x', 'string', 1, 1, 5)",
    );
    expect(() => insert.run(profileId)).toThrow();
  });

  it('throws rather than overwriting a duplicate sheet index or column position', () => {
    const row = uploads.createStaged(staged());
    profiles.insertProfile(row.id, tableProfile());
    expect(() => profiles.insertProfile(row.id, tableProfile())).toThrow(RepositoryError);
    const duplicated = tableProfile({ sheetIndex: 1, columns: [columnProfile({ position: 0 }), columnProfile({ position: 0, name: 'b' })] });
    expect(() => profiles.insertProfile(row.id, duplicated)).toThrow(RepositoryError);
    expect(count('upload_profile')).toBe(1);
  });

  it('saves a workbook whole or not at all', () => {
    const row = uploads.createStaged(staged());
    expect(() => profiles.insertProfiles(row.id, [tableProfile({ sheetIndex: 0 }), tableProfile({ sheetIndex: 0 })])).toThrow(RepositoryError);
    expect(count('upload_profile')).toBe(0);
    profiles.insertProfiles(row.id, [tableProfile({ sheetIndex: 1, sheetName: 'B' }), tableProfile({ sheetIndex: 0, sheetName: 'A' })]);
    expect(profiles.listByUpload(row.id).map(({ sheetName }) => sheetName)).toEqual(['A', 'B']);
  });

  it('returns the disclosure source with columns ordered by position', () => {
    const row = uploads.createStaged(staged());
    uploads.markProfiled(row.id, { encoding: 'windows-1252', durationMs: 1 });
    const columns = [2, 0, 1].map((position) => columnProfile({ position, name: `c${position}` }));
    profiles.insertProfile(row.id, tableProfile({ columns, columnCount: 3 }));
    const source = profiles.getDisclosureSource(row.id);
    expect(source?.upload).toEqual({ originalFilename: 'données été 東京.csv', format: 'csv', byteSize: 42, sha256: SHA, encoding: 'windows-1252' });
    expect(source?.profiles[0]!.columns.map(({ position }) => position)).toEqual([0, 1, 2]);
    expect(profiles.getDisclosureSource(999)).toBeUndefined();
  });
});

describe('cascade', () => {
  it('deletes uploads, profiles, and columns with their task, and leaves no dangling keys', () => {
    const task = tasks.create({ name: 'A', description: 'A' });
    for (let index = 0; index < 2; index += 1) {
      const row = uploads.createStaged(staged());
      uploads.attachToTask(row.id, task.id, 'uploads/1/x.csv');
      profiles.insertProfiles(row.id, [tableProfile({ sheetIndex: 0 }, 3), tableProfile({ sheetIndex: 1 }, 2)]);
    }
    expect([count('upload'), count('upload_profile'), count('upload_column')]).toEqual([2, 4, 10]);
    store.connection.client.prepare('DELETE FROM task WHERE id = ?').run(task.id);
    expect([count('upload'), count('upload_profile'), count('upload_column')]).toEqual([0, 0, 0]);
    expect(store.connection.client.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('keeps unattached uploads when an unrelated task is deleted', () => {
    const task = tasks.create({ name: 'A', description: 'A' });
    uploads.createStaged(staged());
    store.connection.client.prepare('DELETE FROM task WHERE id = ?').run(task.id);
    expect(count('upload')).toBe(1);
  });
});
