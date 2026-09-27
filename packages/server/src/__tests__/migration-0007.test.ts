import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CONVERSATION_EVENT_KINDS } from '@automate/core';
import { ensureAppDirectories, getAppPaths } from '../config/app-paths';
import { openDatabase, type DatabaseConnection } from '../db/client';
import { MIGRATIONS_FOLDER, migrateDatabase } from '../db/migrate';

const MIGRATION_0007 = '20260925211027_artifacts_and_event_kinds';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

/** Every kind that existed before 0007, i.e. all six earlier features' kinds. */
const PRE_0007_KINDS = CONVERSATION_EVENT_KINDS.filter((row) => row.addedIn !== 'FEAT-109' && row.addedIn !== 'FEAT-111').map((row) => row.kind);
const TABLES = ['task', 'execution', 'conversation_event', 'code_version', 'verification_run', 'verification_check', 'verification_finding', 'execution_approval', 'script_run', 'runtime_environment'];

function openAt0006(): DatabaseConnection {
  const root = mkdtempSync(path.join(tmpdir(), 'automate-0007-'));
  roots.push(root);
  const paths = getAppPaths(root);
  ensureAppDirectories(paths);
  const before = path.join(root, 'migrations-before-feat-109');
  mkdirSync(before);
  const folders = readdirSync(MIGRATIONS_FOLDER).filter((name) => statSync(path.join(MIGRATIONS_FOLDER, name)).isDirectory()).sort();
  expect(folders).toContain(MIGRATION_0007);
  for (const folder of folders.filter((name) => name < MIGRATION_0007)) cpSync(path.join(MIGRATIONS_FOLDER, folder), path.join(before, folder), { recursive: true });
  const connection = openDatabase(paths);
  migrateDatabase(connection, before);
  return connection;
}

function seed(c: DatabaseConnection): void {
  c.client.exec(`
    INSERT INTO task (name, description) VALUES ('t', 'd');
    INSERT INTO execution (task_id, status) VALUES (1, 'awaiting_review'), (1, 'failed'), (1, 'completed'), (1, 'awaiting_approval');
    INSERT INTO code_version (execution_id, attempt, status, content_digest, dir_path, is_final, sealed_at) VALUES (1, 1, 'sealed', '${'d'.repeat(64)}', 'scripts/1/attempt-1', 1, 1);
    INSERT INTO verification_run (execution_id, code_version_id, content_digest, runtime_fingerprint, runtime_detail, status, blocking_count, advisory_count, settled_at) VALUES (1, 1, '${'d'.repeat(64)}', '${'f'.repeat(64)}', '{}', 'passed', 0, 1, 2);
    INSERT INTO verification_check (verification_run_id, check_key, status, is_blocking, summary) VALUES (1, 'lint', 'passed', 0, 'ok');
    INSERT INTO verification_finding (check_id, rule_code, severity, message, is_blocking) VALUES (1, 'F401', 'low', 'unused import', 0);
    INSERT INTO execution_approval (execution_id, code_version_id, verification_run_id, content_digest, runtime_fingerprint, intent_digest, decision) VALUES (1, 1, 1, '${'d'.repeat(64)}', '${'f'.repeat(64)}', '${'i'.repeat(64)}', 'approved');
    INSERT INTO script_run (execution_id, code_version_id, approval_id, content_digest, runtime_fingerprint, dir_path, input_manifest, status, exit_code, manifest_present, declared_output_count, produced_output_count, settled_at) VALUES (1, 1, 1, '${'d'.repeat(64)}', '${'f'.repeat(64)}', 'runs/1', '[]', 'succeeded', 0, 1, 2, 2, 3);
    INSERT INTO runtime_environment (kind, spec_digest, lock_digest, python_version, uv_version, platform, arch) VALUES ('script', 's', 'l', '3.14.6', '0.9.0', 'linux', 'x64');
  `);
  const insert = c.client.prepare('INSERT INTO conversation_event (execution_id, seq, kind, payload, at) VALUES (?, ?, ?, ?, ?)');
  for (let seq = 1; seq <= 20; seq += 1) insert.run(1, seq, PRE_0007_KINDS[(seq - 1) % PRE_0007_KINDS.length]!, `{"n":${seq}}`, '2026-09-25T00:00:00Z');
  insert.run(2, 1, 'user_prompt', '{}', '2026-09-25T00:00:00Z');
}

const snapshot = (c: DatabaseConnection) => Object.fromEntries(TABLES.map((table) => [table, c.client.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
const indexes = (c: DatabaseConnection) => c.client.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => (row as { name: string }).name);

describe('migration 0007', () => {
  it('rebuilds conversation_event onto the kind lookup table without losing a row, a sequence number, or an index', () => {
    const c = openAt0006();
    try {
      seed(c);
      const before = snapshot(c);
      const indexesBefore = indexes(c);
      migrateDatabase(c);
      const after = snapshot(c);
      for (const table of TABLES.filter((name) => name !== 'script_run' && name !== 'execution')) expect(after[table], table).toEqual(before[table]);
      expect((after.execution as Record<string, unknown>[]).map(({ as_of_at, as_of_date, as_of_timezone, as_of_source, ...rest }) => { expect([as_of_at, as_of_date, as_of_timezone, as_of_source]).toEqual([null, null, null, null]); return rest; })).toEqual(before.execution);
      expect((after.script_run as Record<string, unknown>[]).map(({ artifact_count, unregistered_output_count, ...rest }) => { expect([artifact_count, unregistered_output_count]).toEqual([null, null]); return rest; })).toEqual(before.script_run);
      const seqs = (c.client.prepare('SELECT seq FROM conversation_event WHERE execution_id = 1 ORDER BY seq').all() as { seq: number }[]).map(({ seq }) => seq);
      expect(seqs).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
      expect(c.client.prepare('SELECT * FROM pragma_foreign_key_check').all()).toEqual([]);
      for (const name of indexesBefore) expect(indexes(c)).toContain(name);
      for (const name of ['conversation_event_execution_seq', 'artifact_execution', 'artifact_task', 'artifact_run_filename']) expect(indexes(c)).toContain(name);
      expect(c.client.prepare('SELECT count(*) AS n FROM conversation_event_kind').get()).toMatchObject({ n: 21 });
    } finally { c.close(); }
  });

  it('accepts artifacts_registered, refuses an unknown kind, and is a no-op when applied twice', () => {
    const c = openAt0006();
    try {
      seed(c);
      migrateDatabase(c);
      c.client.prepare("INSERT INTO conversation_event (execution_id, seq, kind, payload, at) VALUES (1, 21, 'artifacts_registered', '{}', 'x')").run();
      expect(() => c.client.prepare("INSERT INTO conversation_event (execution_id, seq, kind, payload, at) VALUES (1, 22, 'nonsense', '{}', 'x')").run()).toThrow(/FOREIGN KEY/i);
      const once = snapshot(c);
      migrateDatabase(c);
      expect(snapshot(c)).toEqual(once);
      expect(c.client.prepare('SELECT count(*) AS n FROM conversation_event_kind').get()).toMatchObject({ n: 21 });
    } finally { c.close(); }
  });
});
