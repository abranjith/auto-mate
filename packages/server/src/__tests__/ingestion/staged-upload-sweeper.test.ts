import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { TaskRepository } from '../../db/repositories/task-repository';
import { UploadProfileRepository } from '../../db/repositories/upload-profile-repository';
import { UploadRepository, type UploadRow } from '../../db/repositories/upload-repository';
import { INCOMING_GRACE_MS, StagedUploadSweeper } from '../../ingestion/staged-upload-sweeper';
import { UploadFileStore } from '../../ingestion/upload-file-store';
import { SHA, createTempStore, tableProfile, type TempStore } from '../support/ingestion-fixtures';

let store: TempStore;
let uploads: UploadRepository;
let tasks: TaskRepository;
let files: UploadFileStore;
let clock: Date;
const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  store = createTempStore('automate-sweep-');
  clock = new Date('2026-09-20T00:00:00Z');
  uploads = new UploadRepository(store.connection, () => clock);
  tasks = new TaskRepository(store.connection);
  files = new UploadFileStore(store.paths);
});
afterEach(() => {
  vi.useRealTimers();
  store.dispose();
});

function sweeper(now: Date): StagedUploadSweeper {
  return new StagedUploadSweeper({ uploads, tasks, store: files, ttlHours: 24, logger: pino({ level: 'silent' }), now: () => now });
}

async function stagedUpload(): Promise<UploadRow> {
  const row = uploads.stage({ originalFilename: 'a.csv', format: 'csv', mimeType: 'text/csv', byteSize: 4, sha256: SHA }, (id) => ({
    storedFilename: `${id}-a.csv`,
    filePath: files.relative(files.stagedPathFor(id, 'a.csv')),
  }));
  const incoming = files.incomingPath();
  writeFileSync(incoming, 'a,b\n');
  await files.placeStaged(incoming, row.id, row.storedFilename);
  new UploadProfileRepository(store.connection).insertProfile(row.id, tableProfile());
  return row;
}

const onDisk = (row: UploadRow) => existsSync(files.absolute(uploads.getById(row.id)?.filePath ?? row.filePath));

describe('StagedUploadSweeper', () => {
  it('deletes an unattached upload older than the TTL with its file and profile, and keeps a younger one', async () => {
    const old = await stagedUpload();
    clock = new Date('2026-09-21T06:00:00Z');
    const young = await stagedUpload();
    const result = await sweeper(new Date('2026-09-21T12:00:00Z')).sweep();
    expect(result.expiredUploads).toBe(1);
    expect(uploads.getById(old.id)).toBeUndefined();
    expect(existsSync(files.stagedDirFor(old.id))).toBe(false);
    expect(uploads.getById(young.id)).toBeDefined();
    expect(onDisk(young)).toBe(true);
    expect(store.connection.client.prepare('SELECT count(*) AS count FROM upload_profile').get()).toEqual({ count: 1 });
  });

  it('never touches an attached upload, whatever its age', async () => {
    const task = tasks.create({ name: 'A', description: 'A' });
    const row = await stagedUpload();
    const staged = uploads.getById(row.id)!;
    uploads.attachToTask(row.id, task.id, files.relative(files.taskPathFor(task.id, row.id, 'a.csv')));
    await files.attach(staged, task.id);
    await sweeper(new Date('2030-01-01T00:00:00Z')).sweep();
    expect(uploads.getById(row.id)?.taskId).toBe(task.id);
    expect(onDisk(row)).toBe(true);
  });

  it('removes a staged directory with no database row, and stale partial files but not fresh ones', async () => {
    mkdirSync(files.stagedDirFor(41));
    writeFileSync(path.join(files.stagedDirFor(41), '41-x.csv'), 'x');
    const stale = files.incomingPath();
    writeFileSync(stale, 'x');
    const old = new Date(clock.getTime() - INCOMING_GRACE_MS - 1000);
    utimesSync(stale, old, old);
    const fresh = files.incomingPath();
    writeFileSync(fresh, 'x');
    const result = await sweeper(new Date()).sweep();
    expect(result.orphanedStagedEntries).toBe(2);
    expect(existsSync(files.stagedDirFor(41))).toBe(false);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('removes the upload directory of a deleted task, completing "deleted with its task"', async () => {
    const task = tasks.create({ name: 'A', description: 'A' });
    const row = await stagedUpload();
    const staged = uploads.getById(row.id)!;
    uploads.attachToTask(row.id, task.id, files.relative(files.taskPathFor(task.id, row.id, 'a.csv')));
    await files.attach(staged, task.id);
    store.connection.client.prepare('DELETE FROM task WHERE id = ?').run(task.id);
    expect(store.connection.client.prepare('SELECT (SELECT count(*) FROM upload) + (SELECT count(*) FROM upload_profile) + (SELECT count(*) FROM upload_column) AS rows').get()).toEqual({ rows: 0 });
    const result = await sweeper(clock).sweep();
    expect(result.orphanedTaskDirectories).toBe(1);
    expect(existsSync(store.paths.uploadsDirForTask(task.id))).toBe(false);
  });

  it('is idempotent across two runs', async () => {
    await stagedUpload();
    const later = new Date('2026-09-22T00:00:00Z');
    expect(await sweeper(later).sweep()).toEqual({ expiredUploads: 1, orphanedStagedEntries: 0, orphanedTaskDirectories: 0 });
    expect(await sweeper(later).sweep()).toEqual({ expiredUploads: 0, orphanedStagedEntries: 0, orphanedTaskDirectories: 0 });
  });

  it('schedules repeats and clears its interval on stop, leaving no timer behind', () => {
    vi.useFakeTimers();
    const instance = sweeper(clock);
    const sweep = vi.spyOn(instance, 'sweep').mockResolvedValue({ expiredUploads: 0, orphanedStagedEntries: 0, orphanedTaskDirectories: 0 });
    instance.start();
    instance.start();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(2 * HOUR);
    expect(sweep).toHaveBeenCalledTimes(2);
    instance.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
