// FEAT-107 migration: the two riskiest rebuilds in the project so far —
// `execution` (five inbound foreign keys plus a self-reference) and the third
// rebuild of `conversation_event`. A migration that quietly empties a
// transcript is discovered by a user rather than a test; this is the test.
import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureAppDirectories, getAppPaths } from '../config/app-paths';
import { openDatabase, type DatabaseConnection } from '../db/client';
import { MIGRATIONS_FOLDER, migrateDatabase } from '../db/migrate';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const REBUILT_INDEXES = ['conversation_event_execution_seq', 'execution_task_id', 'execution_active', 'execution_parked', 'execution_retry_of'];
const NEW_OBJECTS = ['verification_run', 'verification_check', 'verification_finding', 'execution_approval', 'script_run', 'verification_run_scope', 'verification_run_execution', 'verification_check_key', 'verification_finding_check', 'verification_finding_blocking', 'execution_approval_granted', 'execution_approval_execution', 'script_run_execution'];
const COUNTED = ['task', 'execution', 'conversation_event', 'upload', 'code_version', 'code_file', 'generation_attempt', 'synthetic_fixture'];

/** Open a fresh data root migrated to everything before FEAT-107's migration. */
function atPrevious(): { connection: DatabaseConnection; root: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'automate-0005-'));
  roots.push(root);
  const paths = getAppPaths(root);
  ensureAppDirectories(paths);
  const before = path.join(root, 'migrations-before-feat-107');
  mkdirSync(before);
  const folders = readdirSync(MIGRATIONS_FOLDER).filter((name) => statSync(path.join(MIGRATIONS_FOLDER, name)).isDirectory()).sort();
  for (const folder of folders.filter((name) => name < '20260925161513_equal_synch')) cpSync(path.join(MIGRATIONS_FOLDER, folder), path.join(before, folder), { recursive: true });
  const connection = openDatabase(paths);
  migrateDatabase(connection, before);
  return { connection, root };
}

function seed(connection: DatabaseConnection): void {
  const run = (sql: string, ...params: (string | number | null)[]) => connection.client.prepare(sql).run(...params);
  run("INSERT INTO task (name, description) VALUES ('t', 'Total sales by region')");
  run("INSERT INTO execution (task_id, status, trigger) VALUES (1, 'failed', 'manual')");
  run("INSERT INTO execution (task_id, status, trigger, retry_of_execution_id, guidance) VALUES (1, 'generating', 'rerun', 1, 'use the amount column')");
  for (let seq = 1; seq <= 10; seq += 1) run('INSERT INTO conversation_event (execution_id, seq, kind, payload, at) VALUES (2, ?, ?, ?, ?)', seq, seq === 1 ? 'user_prompt' : 'assistant_text', JSON.stringify({ seq, text: `event ${seq} — 日本` }), '2026-09-25T00:00:00.000Z');
  run("INSERT INTO upload (task_id, original_filename, stored_filename, file_path, format, mime_type, byte_size, sha256, profile_status) VALUES (1, 'sales.csv', 'upload-1.csv', 'uploads/1/upload-1.csv', 'csv', 'text/csv', 10, ?, 'profiled')", 'c'.repeat(64));
  for (const attempt of [1, 2]) {
    run("INSERT INTO code_version (execution_id, attempt, status, content_digest, dir_path, is_final, sealed_at) VALUES (2, ?, 'tested_pass', ?, ?, ?, 1)", attempt, String(attempt).repeat(64), `scripts/2/attempt-${attempt}`, attempt === 2 ? 1 : 0);
    run("INSERT INTO code_file (code_version_id, path, role, content, byte_size, sha256) VALUES (?, 'main.py', 'script', 'print(1)', 8, ?)", attempt, 'd'.repeat(64));
  }
  run("INSERT INTO generation_attempt (execution_id, code_version_id, attempt, status, settled_at) VALUES (2, 2, 1, 'passed', 1)");
  run("INSERT INTO synthetic_fixture (execution_id, upload_id, file_path, format, row_count, sample_row_count, byte_size, sha256, seed) VALUES (2, 1, 'scripts/2/fixtures/upload-1.csv', 'csv', 200, 10, 100, ?, 'abc')", 'e'.repeat(64));
}

const snapshot = (connection: DatabaseConnection) => Object.fromEntries(COUNTED.map((table) => [table, connection.client.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));

describe('migration 0005 (FEAT-107)', () => {
  it('keeps every row, id, and seq across both rebuilds and passes foreign_key_check', () => {
    const { connection } = atPrevious();
    try {
      seed(connection);
      const before = snapshot(connection);
      migrateDatabase(connection);
      const after = snapshot(connection);
      for (const table of COUNTED) expect(after[table], table).toHaveLength((before[table] as unknown[]).length);
      expect(after.conversation_event).toEqual(before.conversation_event);
      expect(after.code_version).toEqual(before.code_version);
      expect(after.code_file).toEqual(before.code_file);
      expect(after.generation_attempt).toEqual(before.generation_attempt);
      expect(after.synthetic_fixture).toEqual(before.synthetic_fixture);
      expect((after.execution as Record<string, unknown>[]).map(({ review_feedback, reviewed_at, ...rest }) => { expect(review_feedback).toBeNull(); expect(reviewed_at).toBeNull(); return rest; })).toEqual(before.execution);
      const seqs = (connection.client.prepare('SELECT seq FROM conversation_event WHERE execution_id = 2 ORDER BY seq').all() as { seq: number }[]).map(({ seq }) => seq);
      expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(connection.client.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      connection.close();
    }
  });

  it('recreates every index on both rebuilt tables and creates the new tables', () => {
    const { connection } = atPrevious();
    try {
      migrateDatabase(connection);
      const names = (connection.client.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all() as { name: string }[]).map(({ name }) => name);
      expect(names).toEqual(expect.arrayContaining([...REBUILT_INDEXES, ...NEW_OBJECTS]));
      const active = connection.client.prepare("SELECT sql FROM sqlite_master WHERE name = 'execution_active'").get() as { sql: string };
      expect(active.sql).not.toMatch(/awaiting/);
      const parked = connection.client.prepare("SELECT sql FROM sqlite_master WHERE name = 'execution_parked'").get() as { sql: string };
      expect(parked.sql).toMatch(/'awaiting_approval','awaiting_review'/);
    } finally {
      connection.close();
    }
  });

  it('widens the CHECKs and still rejects nonsense', () => {
    const { connection } = atPrevious();
    try {
      seed(connection);
      migrateDatabase(connection);
      const run = (sql: string) => connection.client.prepare(sql).run();
      expect(() => run("UPDATE execution SET status = 'awaiting_review' WHERE id = 2")).not.toThrow();
      expect(() => run("INSERT INTO execution (task_id, trigger) VALUES (1, 'feedback')")).not.toThrow();
      expect(() => run("UPDATE execution SET status = 'nonsense' WHERE id = 2")).toThrow(/CHECK/);
      expect(() => run("INSERT INTO execution (task_id, trigger) VALUES (1, 'nonsense')")).toThrow(/CHECK/);
      for (const kind of ['verification_finished', 'approval_decided', 'run_finished', 'review_decided']) run(`INSERT INTO conversation_event (execution_id, seq, kind, payload, at) VALUES (2, (SELECT max(seq) + 1 FROM conversation_event WHERE execution_id = 2), '${kind}', '{}', 'x')`);
      expect(() => run("INSERT INTO conversation_event (execution_id, seq, kind, payload, at) VALUES (2, 99, 'nonsense', '{}', 'x')")).toThrow(/CHECK/);
      expect(() => run("INSERT INTO conversation_event (execution_id, seq, kind, payload, at) VALUES (2, 1, 'user_prompt', '{}', 'x')")).toThrow(/UNIQUE/);
      // The self-reference survived the rename: deleting the source sets the link to NULL, never deletes the retry.
      run('DELETE FROM execution WHERE id = 1');
      expect(connection.client.prepare('SELECT retry_of_execution_id AS link FROM execution WHERE id = 2').get()).toEqual({ link: null });
    } finally {
      connection.close();
    }
  });

  it('is a no-op when applied twice and leaves foreign keys on', () => {
    const { connection } = atPrevious();
    try {
      seed(connection);
      migrateDatabase(connection);
      const once = snapshot(connection);
      migrateDatabase(connection);
      expect(snapshot(connection)).toEqual(once);
      expect(connection.client.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    } finally {
      connection.close();
    }
  });

  it('rolls the whole migration back when foreign_key_check finds an orphan', () => {
    const { connection } = atPrevious();
    try {
      seed(connection);
      connection.client.exec('PRAGMA foreign_keys = OFF;');
      connection.client.prepare("INSERT INTO code_file (code_version_id, path, role, content, byte_size, sha256) VALUES (999, 'x.py', 'script', 'x', 1, 'x')").run();
      connection.client.exec('PRAGMA foreign_keys = ON;');
      expect(() => migrateDatabase(connection)).toThrow(/could not be updated/);
      const tables = (connection.client.prepare("SELECT name FROM sqlite_master WHERE name = 'verification_run'").all());
      expect(tables).toEqual([]);
      expect(() => connection.client.prepare("UPDATE execution SET status = 'awaiting_review' WHERE id = 2").run()).toThrow(/CHECK/);
      expect(connection.client.prepare('SELECT count(*) AS n FROM conversation_event').get()).toEqual({ n: 10 });
    } finally {
      connection.close();
    }
  });
});
