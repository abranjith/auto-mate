import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureAppDirectories, getAppPaths } from '../config/app-paths';
import { openDatabase } from '../db/client';
import { migrateDatabase } from '../db/migrate';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

it('applies and seeds the initial migration exactly once', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'automate-')); roots.push(root);
  const paths = getAppPaths(root); ensureAppDirectories(paths);
  const connection = openDatabase(paths);
  try {
    migrateDatabase(connection);
    migrateDatabase(connection);
    expect(existsSync(paths.dbFile)).toBe(true);
    const rows = connection.client.prepare('SELECT key FROM app_meta ORDER BY key').all();
    expect(rows).toEqual([{ key: 'app_version' }, { key: 'installed_at' }, { key: 'schema_version' }]);
    const count = connection.client.prepare('SELECT count(*) AS count FROM __drizzle_migrations').get() as { count: number };
    expect(count.count).toBe(1);
    expect(() => connection.client.prepare("INSERT INTO app_meta (key, value) VALUES (NULL, 'invalid')").run()).toThrow();
  } finally { connection.close(); }
});
