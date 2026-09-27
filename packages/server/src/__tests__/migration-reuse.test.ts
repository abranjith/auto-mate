import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureAppDirectories, getAppPaths } from '../config/app-paths';
import { openDatabase } from '../db/client';
import { migrateDatabase } from '../db/migrate';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('FEAT-111 migrations', () => {
  it('adds four execution columns without rebuilding historical runs', () => {
    const sql = readFileSync(path.join(import.meta.dirname, '../../drizzle/20260926160041_save_and_rerun/migration.sql'), 'utf8');
    expect(sql.match(/ALTER TABLE `execution` ADD/g)).toHaveLength(4);
    expect(sql).not.toMatch(/DROP TABLE [`"]?execution|CREATE TABLE [`"]?__new_execution/i);
  });

  it('keeps revisions immutable while allowing source task deletion', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'automate-reuse-migration-')); roots.push(root);
    const paths = getAppPaths(root); ensureAppDirectories(paths);
    const connection = openDatabase(paths);
    try {
      migrateDatabase(connection);
      const db = connection.client;
      db.exec("INSERT INTO task(name, description) VALUES ('Source', 'Source task'); INSERT INTO execution(task_id, status) VALUES (1, 'completed'); INSERT INTO task_template(name, description) VALUES ('Saved', 'Source task');");
      db.prepare("INSERT INTO template_revision(template_id, revision_number, source_execution_id, content_digest, entrypoint, summary, declared_inputs, declared_outputs, input_contract, contract_digest, runtime_fingerprint, runtime_detail, reads_wall_clock) VALUES (1, 1, 1, ?, 'main.py', 'summary', '[]', '[]', '{}', ?, ?, '{}', 0)").run('a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64));
      db.prepare("INSERT INTO template_revision_file(revision_id, path, role, content, byte_size, sha256) VALUES (1, 'main.py', 'script', 'print(1)', 8, ?)").run('d'.repeat(64));
      expect(() => db.exec("UPDATE template_revision SET summary = 'changed' WHERE id = 1")).toThrow(/immutable/);
      expect(() => db.exec("UPDATE template_revision SET source_execution_id = 2 WHERE id = 1")).toThrow(/immutable/);
      expect(() => db.exec("UPDATE template_revision_file SET content = 'changed' WHERE id = 1")).toThrow(/immutable/);
      db.exec('DELETE FROM task WHERE id = 1');
      expect(db.prepare('SELECT source_execution_id FROM template_revision WHERE id = 1').get()).toEqual({ source_execution_id: null });
      expect(db.prepare('SELECT count(*) AS n FROM template_revision_file').get()).toEqual({ n: 1 });
      db.exec('DELETE FROM task_template WHERE id = 1');
      expect(db.prepare('SELECT count(*) AS n FROM template_revision_file').get()).toEqual({ n: 0 });
    } finally { connection.close(); }
  });
});
