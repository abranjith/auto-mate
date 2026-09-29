import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureAppDirectories, getAppPaths } from '../config/app-paths';
import { openDatabase } from '../db/client';
import { MIGRATIONS_FOLDER, migrateDatabase } from '../db/migrate';

const current = '20260929010815_silent_quentin_quire';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('clarification follow-up migration', () => {
  it('preserves old rows and enforces one cascading child per parent', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'automate-follow-up-migration-')); roots.push(root);
    const paths = getAppPaths(root); ensureAppDirectories(paths);
    const before = path.join(root, 'before'); mkdirSync(before);
    for (const folder of readdirSync(MIGRATIONS_FOLDER).filter((name) => statSync(path.join(MIGRATIONS_FOLDER, name)).isDirectory() && name < current)) cpSync(path.join(MIGRATIONS_FOLDER, folder), path.join(before, folder), { recursive: true });
    const c = openDatabase(paths);
    try {
      migrateDatabase(c, before);
      c.client.exec("insert into task (name, description) values ('t', 'd'); insert into execution (task_id, status) values (1, 'generating'); insert into clarification (execution_id, source, status, asked_at, created_at) values (1, 'agent', 'answered', 1, 1); insert into clarification_question (clarification_id, position, impact, prompt_text, rationale, proposed_default, answer, answer_source, created_at) values (1, 0, 'meaning', 'Original?', 'Reason', 'yes', 'typed', 'user', 1)");
      migrateDatabase(c);
      expect(c.client.prepare('select follow_up_of_question_id from clarification_question where id = 1').get()).toMatchObject({ follow_up_of_question_id: null });
      const insert = c.client.prepare("insert into clarification_question (clarification_id, position, impact, prompt_text, rationale, proposed_default, follow_up_of_question_id, created_at) values (1, ?, 'meaning', 'Follow-up?', 'Reason', 'yes', 1, 1)");
      insert.run(1);
      expect(() => insert.run(2)).toThrow();
      c.client.prepare('delete from clarification_question where id = 1').run();
      expect(c.client.prepare('select count(*) n from clarification_question').get()).toMatchObject({ n: 0 });
      expect(c.client.prepare('pragma foreign_key_check').all()).toEqual([]);
    } finally { c.close(); }
  });
});
