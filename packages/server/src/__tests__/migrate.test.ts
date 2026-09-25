import { afterEach, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureAppDirectories, getAppPaths } from '../config/app-paths';
import { openDatabase } from '../db/client';
import { MIGRATIONS_FOLDER, migrateDatabase } from '../db/migrate';

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
    expect(count.count).toBe(7);
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
    expect(applied.count).toBe(7);
  } finally {
    connection.close();
  }
});

const GENERATION_TABLES = ['code_file', 'code_version', 'generation_attempt', 'synthetic_fixture'];
const GENERATION_INDEXES = ['code_file_path', 'code_version_attempt', 'code_version_digest', 'code_version_draft', 'code_version_final', 'execution_retry_of', 'generation_attempt_call', 'generation_attempt_number', 'generation_attempt_version', 'synthetic_fixture_upload'];

it('creates the generation tables and indexes in one additional migration (FEAT-106)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'automate-'));
  roots.push(root);
  const paths = getAppPaths(root);
  ensureAppDirectories(paths);
  const connection = openDatabase(paths);
  try {
    migrateDatabase(connection);
    migrateDatabase(connection);
    const names = (connection.client.prepare(`SELECT name FROM sqlite_master WHERE name IN (${[...GENERATION_TABLES, ...GENERATION_INDEXES].map(() => '?').join(',')}) ORDER BY name`).all(...GENERATION_TABLES, ...GENERATION_INDEXES) as { name: string }[]).map(({ name }) => name);
    expect(names).toEqual([...GENERATION_TABLES, ...GENERATION_INDEXES].sort());
    const columns = (connection.client.prepare('PRAGMA table_info(execution)').all() as { name: string }[]).map(({ name }) => name);
    expect(columns).toEqual(expect.arrayContaining(['retry_of_execution_id', 'guidance']));
    const partial = connection.client.prepare("SELECT sql FROM sqlite_master WHERE name = 'code_version_final'").get() as { sql: string };
    expect(partial.sql).toMatch(/WHERE .*is_final.* = 1/i);
    const applied = connection.client.prepare('SELECT count(*) AS count FROM __drizzle_migrations').get() as { count: number };
    expect(applied.count).toBe(7);
  } finally {
    connection.close();
  }
});

it('keeps every conversation event, its seq, kind, and payload across the FEAT-106 table rebuild', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'automate-'));
  roots.push(root);
  const paths = getAppPaths(root);
  ensureAppDirectories(paths);
  const migrations = MIGRATIONS_FOLDER;
  const before = path.join(root, 'migrations-before-feat-106');
  mkdirSync(before);
  const folders = readdirSync(migrations).filter((name) => statSync(path.join(migrations, name)).isDirectory()).sort();
  for (const folder of folders.filter((name) => name < '20260925044250_damp_otto_octavius')) cpSync(path.join(migrations, folder), path.join(before, folder), { recursive: true });
  const connection = openDatabase(paths);
  try {
    migrateDatabase(connection, before);
    connection.client.prepare("INSERT INTO task (name, description) VALUES ('t', 'd')").run();
    connection.client.prepare("INSERT INTO execution (task_id, status) VALUES (1, 'completed')").run();
    const rows = [['user_prompt', '{"type":"user_prompt","text":"Hi — 日本","seq":1}'], ['disclosure_sent', '{"type":"disclosure_sent","seq":2}'], ['clarification_requested', '{"type":"clarification_requested","seq":3}'], ['clarification_answered', '{"type":"clarification_answered","seq":4}']];
    rows.forEach(([kind, payload], index) => connection.client.prepare('INSERT INTO conversation_event (execution_id, seq, kind, payload, at) VALUES (1, ?, ?, ?, ?)').run(index + 1, kind!, payload!, '2026-09-24T00:00:00.000Z'));
    expect(() => connection.client.prepare("INSERT INTO conversation_event (execution_id, seq, kind, payload, at) VALUES (1, 9, 'code_version_sealed', '{}', 'x')").run()).toThrow(/CHECK/);
    migrateDatabase(connection);
    const after = connection.client.prepare('SELECT seq, kind, payload FROM conversation_event ORDER BY seq').all() as { seq: number; kind: string; payload: string }[];
    expect(after).toEqual(rows.map(([kind, payload], index) => ({ seq: index + 1, kind, payload })));
    for (const kind of ['code_version_sealed', 'test_run_finished', 'generation_settled', 'disclosure_sent']) connection.client.prepare('INSERT INTO conversation_event (execution_id, seq, kind, payload, at) VALUES (1, (SELECT max(seq) + 1 FROM conversation_event), ?, ?, ?)').run(kind, '{}', 'x');
    expect(() => connection.client.prepare("INSERT INTO conversation_event (execution_id, seq, kind, payload, at) VALUES (1, 1, 'user_prompt', '{}', 'x')").run()).toThrow(/UNIQUE/);
    expect(() => connection.client.prepare("INSERT INTO conversation_event (execution_id, seq, kind, payload, at) VALUES (1, 99, 'mystery', '{}', 'x')").run()).toThrow(/CHECK/);
    expect(connection.client.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    connection.close();
  }
});
