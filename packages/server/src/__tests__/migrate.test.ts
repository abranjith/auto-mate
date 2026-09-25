import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureAppDirectories, getAppPaths } from '../config/app-paths';
import { openDatabase } from '../db/client';
import { migrateDatabase } from '../db/migrate';

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);

it('applies and seeds the initial migration exactly once', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'automate-'));
  roots.push(root);
  const paths = getAppPaths(root);
  ensureAppDirectories(paths);
  const connection = openDatabase(paths);
  try {
    migrateDatabase(connection);
    migrateDatabase(connection);
    expect(existsSync(paths.dbFile)).toBe(true);
    const rows = connection.client
      .prepare('SELECT key FROM app_meta ORDER BY key')
      .all();
    expect(rows).toEqual([
      { key: 'app_version' },
      { key: 'installed_at' },
      { key: 'schema_version' },
    ]);
    const count = connection.client
      .prepare('SELECT count(*) AS count FROM __drizzle_migrations')
      .get() as { count: number };
    expect(count.count).toBe(4);
    const objects = connection.client
      .prepare(
        "SELECT name FROM sqlite_master WHERE name IN ('task','execution','conversation_event','conversation_event_execution_seq','execution_task_id','execution_active') ORDER BY name",
      )
      .all();
    expect(objects).toHaveLength(6);
    expect(() =>
      connection.client
        .prepare("INSERT INTO app_meta (key, value) VALUES (NULL, 'invalid')")
        .run(),
    ).toThrow();
  } finally {
    connection.close();
  }
});

it('creates the ingestion tables and indexes in one additional migration (FEAT-104)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'automate-'));
  roots.push(root);
  const paths = getAppPaths(root);
  ensureAppDirectories(paths);
  const connection = openDatabase(paths);
  try {
    migrateDatabase(connection);
    migrateDatabase(connection);
    const names = connection.client
      .prepare(
        "SELECT name FROM sqlite_master WHERE name IN ('upload','upload_profile','upload_column','upload_task_id','upload_staged','upload_profile_sheet','upload_column_position','upload_column_name') ORDER BY name",
      )
      .all()
      .map((row) => (row as { name: string }).name);
    expect(names).toEqual(['upload', 'upload_column', 'upload_column_name', 'upload_column_position', 'upload_profile', 'upload_profile_sheet', 'upload_staged', 'upload_task_id']);
    const staged = connection.client.prepare("SELECT sql FROM sqlite_master WHERE name = 'upload_staged'").get() as { sql: string };
    expect(staged.sql).toMatch(/WHERE .*task_id.* is null/i);
    const applied = connection.client.prepare('SELECT count(*) AS count FROM __drizzle_migrations').get() as { count: number };
    expect(applied.count).toBe(4);
  } finally {
    connection.close();
  }
});
