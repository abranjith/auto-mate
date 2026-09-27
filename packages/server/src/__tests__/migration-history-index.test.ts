import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { INTERRUPTED_ON_RESTART, PARKED_STATUSES } from '@automate/core';
import { ensureAppDirectories, getAppPaths } from '../config/app-paths';
import { openDatabase } from '../db/client';
import { MIGRATIONS_FOLDER, migrateDatabase } from '../db/migrate';

const roots: string[] = [];
/** The quoted statuses of a partial index predicate, in order. */
const inList = (sql: string): string[] => [...(/ in \(([^)]*)\)/i.exec(sql)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!);
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
describe('FEAT-110 history index migration', () => {
  it('widens only the parked index and preserves every run', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'automate-history-migrate-')); roots.push(root);
    const paths = getAppPaths(root); ensureAppDirectories(paths);
    const before = path.join(root, 'before-history'); mkdirSync(before);
    for (const folder of readdirSync(MIGRATIONS_FOLDER).filter((name) => statSync(path.join(MIGRATIONS_FOLDER, name)).isDirectory()).sort().filter((name) => name < '20260926014135_history_index')) cpSync(path.join(MIGRATIONS_FOLDER, folder), path.join(before, folder), { recursive: true });
    const connection = openDatabase(paths);
    try {
      migrateDatabase(connection, before);
      connection.client.prepare("insert into task (name, description) values ('t', 'task')").run();
      const insert = connection.client.prepare('insert into execution (task_id, status) values (1, ?)');
      for (const status of new Set([...INTERRUPTED_ON_RESTART, ...PARKED_STATUSES, 'completed', 'failed', 'aborted', 'rejected'])) insert.run(status);
      const rows = connection.client.prepare('select id, status from execution order by id').all();
      migrateDatabase(connection);
      expect(connection.client.prepare('select id, status from execution order by id').all()).toEqual(rows);
      const parked = connection.client.prepare("select sql from sqlite_master where name = 'execution_parked'").get() as { sql: string };
      expect(inList(parked.sql)).toEqual([...PARKED_STATUSES]);
      const active = connection.client.prepare("select sql from sqlite_master where name = 'execution_active'").get() as { sql: string };
      expect(inList(active.sql)).toEqual([...INTERRUPTED_ON_RESTART]);
      migrateDatabase(connection);
      expect(connection.client.prepare('select id, status from execution order by id').all()).toEqual(rows);
    } finally { connection.close(); }
  });
});
