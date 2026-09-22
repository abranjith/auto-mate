import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureAppDirectories, getAppPaths } from '../config/app-paths';
import { openDatabase } from './client';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('SQLite client', () => {
  it('enables WAL and foreign keys and closes twice safely', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'automate-')); roots.push(root);
    const paths = getAppPaths(root); ensureAppDirectories(paths);
    const connection = openDatabase(paths);
    expect(connection.client.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(connection.client.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    connection.close(); connection.close();
  });
});
