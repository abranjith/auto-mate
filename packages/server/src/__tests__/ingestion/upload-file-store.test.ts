import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ValidationError } from '@automate/core';
import { ensureAppDirectories, getAppPaths, type AppPaths } from '../../config/app-paths';
import { MAX_SANITIZED_NAME, UploadFileStore, sanitizeFilename, stripControlCharacters } from '../../ingestion/upload-file-store';

let root: string;
let paths: AppPaths;
let store: UploadFileStore;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'automate-store-'));
  paths = getAppPaths(root);
  ensureAppDirectories(paths);
  store = new UploadFileStore(paths);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('sanitizeFilename', () => {
  it.each([
    ['../../etc/passwd', 'passwd'],
    ['..\\..\\Windows\\system.ini', 'system.ini'],
    ['/etc/passwd', 'passwd'],
    ['C:\\Users\\me\\sales.csv', 'sales.csv'],
    ['.hidden.csv', 'hidden.csv'],
    ['...', 'upload'],
    ['a\u0000b\u001fc.csv', 'abc.csv'],
    ['Données été 2026.csv', 'Donnees-ete-2026.csv'],
    ['東京 sales.xlsx', 'sales.xlsx'],
    ['report (final) #2.xlsx', 'report-final-2.xlsx'],
    ['', 'upload'],
  ])('turns %j into %j', (original, expected) => expect(sanitizeFilename(original)).toBe(expected));

  it('truncates a 300-character name to 100 characters and keeps the extension', () => {
    const name = sanitizeFilename(`${'a'.repeat(300)}.xlsx`);
    expect(name).toHaveLength(MAX_SANITIZED_NAME);
    expect(name.endsWith('.xlsx')).toBe(true);
  });

  it('only ever yields safe characters', () => {
    for (const original of ['<script>.csv', 'a|b:c*d?.csv', 'con.csv', ' spaced .csv']) {
      expect(sanitizeFilename(original)).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    }
  });

  it('strips control characters without a control-character regex', () => {
    expect(stripControlCharacters('a\u0007b\u007fc\n')).toBe('abc');
  });
});

describe('UploadFileStore paths', () => {
  it('builds staged and task paths inside the data root', () => {
    expect(store.stagedPathFor(7, 'sales.csv')).toBe(path.join(paths.uploadsDir, 'staged', '7', '7-sales.csv'));
    expect(store.taskPathFor(3, 7, 'sales.csv')).toBe(path.join(paths.uploadsDir, '3', '7-sales.csv'));
    expect(store.relative(store.taskPathFor(3, 7, 'sales.csv'))).toBe('uploads/3/7-sales.csv');
    expect(store.absolute('uploads/3/7-sales.csv')).toBe(store.taskPathFor(3, 7, 'sales.csv'));
  });

  it('refuses an unsanitized name that would leave its directory, even though sanitizing would have caught it', () => {
    for (const name of ['../../../x', '/../../../etc/passwd', 'a/b.csv', '..\\..\\x']) {
      expect(() => store.stagedPathFor(1, name)).toThrow(ValidationError);
      expect(() => store.taskPathFor(1, 1, name)).toThrow(ValidationError);
    }
  });

  it('refuses stored paths and ids that point outside the uploads directory', () => {
    expect(() => store.absolute('data/automate.db')).toThrow(ValidationError);
    expect(() => store.absolute('uploads/../data/automate.db')).toThrow(ValidationError);
    expect(() => store.relative(paths.dbFile)).toThrow(ValidationError);
    expect(() => store.stagedDirFor(0)).toThrow(ValidationError);
    expect(() => store.taskPathFor(-1, 1, 'a.csv')).toThrow(ValidationError);
  });
});

describe('UploadFileStore files', () => {
  it('places incoming bytes, attaches them to a task atomically, and removes the staged directory', async () => {
    const incoming = store.incomingPath();
    writeFileSync(incoming, 'a,b\n1,2\n');
    const staged = await store.placeStaged(incoming, 5, '5-data.csv');
    expect(staged).toBe('uploads/staged/5/5-data.csv');
    expect(existsSync(incoming)).toBe(false);
    const moved = await store.attach({ id: 5, storedFilename: '5-data.csv', filePath: staged }, 9);
    expect(moved).toBe('uploads/9/5-data.csv');
    expect(readFileSync(store.absolute(moved), 'utf8')).toBe('a,b\n1,2\n');
    expect(existsSync(store.stagedDirFor(5))).toBe(false);
  });

  it('removes files, tolerating ones already gone', async () => {
    const incoming = store.incomingPath();
    writeFileSync(incoming, 'x');
    const staged = await store.placeStaged(incoming, 6, '6-x.csv');
    await store.removeFiles({ id: 6, filePath: staged });
    await store.removeFiles({ id: 6, filePath: staged });
    expect(existsSync(store.stagedDirFor(6))).toBe(false);
  });

  it('lists staged entries by kind, and task directories by id', async () => {
    writeFileSync(store.incomingPath(), 'x');
    mkdirSync(store.stagedDirFor(12));
    mkdirSync(paths.uploadsDirForTask(4));
    const entries = await store.listStagedEntries();
    expect(entries.map(({ uploadId, incoming }) => [uploadId, incoming]).sort()).toEqual([
      [12, false],
      [null, true],
    ].sort());
    expect(await store.listTaskDirectories()).toEqual([4]);
    await store.removeTaskDirectory(4);
    expect(await store.listTaskDirectories()).toEqual([]);
  });
});
