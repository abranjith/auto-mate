import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureAppDirectories, getAppPaths } from '../config/app-paths';
import { openDatabase } from '../db/client';
import { MIGRATIONS_FOLDER, migrateDatabase } from '../db/migrate';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('migration 0006', () => {
  it('preserves transcript ids and sequences, adds runtime storage and checks foreign keys', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'automate-0006-'));
    roots.push(root);
    const paths = getAppPaths(root);
    ensureAppDirectories(paths);
    const before = path.join(root, 'migrations-before-feat-108');
    mkdirSync(before);
    const folders = readdirSync(MIGRATIONS_FOLDER).filter((name) => statSync(path.join(MIGRATIONS_FOLDER, name)).isDirectory()).sort();
    for (const folder of folders.filter((name) => name < '20260925194955_safe_blackheart')) cpSync(path.join(MIGRATIONS_FOLDER, folder), path.join(before, folder), { recursive: true });
    const connection = openDatabase(paths);
    try {
      migrateDatabase(connection, before);
      connection.client.exec("INSERT INTO task (name, description) VALUES ('t', 'd'); INSERT INTO execution (task_id, status, trigger) VALUES (1, 'failed', 'manual');");
      for (let seq = 1; seq <= 12; seq += 1) connection.client.prepare('INSERT INTO conversation_event (execution_id, seq, kind, payload, at) VALUES (1, ?, ?, ?, ?)').run(seq, seq === 1 ? 'user_prompt' : 'assistant_text', '{}', '2026-09-25T00:00:00Z');
      const old = connection.client.prepare('SELECT id, seq, kind FROM conversation_event ORDER BY seq').all();
      migrateDatabase(connection);
      expect(connection.client.prepare('SELECT id, seq, kind FROM conversation_event ORDER BY seq').all()).toEqual(old);
      expect(connection.client.prepare('SELECT * FROM pragma_foreign_key_check').all()).toEqual([]);
      const indexes = connection.client.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((row) => (row as { name: string }).name);
      for (const name of ['conversation_event_execution_seq', 'script_run_execution', 'runtime_environment_scope', 'runtime_environment_fingerprint', 'runtime_environment_ready']) expect(indexes).toContain(name);
      connection.client.prepare("INSERT INTO conversation_event (execution_id, seq, kind, payload, at) VALUES (1, 13, 'runtime_prepared', '{}', '2026-09-25T00:00:00Z')").run();
      expect(() => connection.client.prepare("INSERT INTO conversation_event (execution_id, seq, kind, payload, at) VALUES (1, 14, 'nonsense', '{}', '2026-09-25T00:00:00Z')").run()).toThrow();
      migrateDatabase(connection);
      expect(connection.client.prepare('SELECT count(*) AS n FROM conversation_event').get()).toMatchObject({ n: 13 });
    } finally { connection.client.close(); }
  });
});
