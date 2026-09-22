import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureAppDirectories, getAppPaths } from '../../config/app-paths';
import { openDatabase } from '../client';
import { migrateDatabase } from '../migrate';
import { AppMetaRepository } from './app-meta-repository';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('application metadata repository', () => {
  it('reads seeds, inserts, updates and advances timestamps', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'automate-')); roots.push(root);
    const paths = getAppPaths(root); ensureAppDirectories(paths);
    const connection = openDatabase(paths);
    try {
      migrateDatabase(connection);
      const repository = new AppMetaRepository(connection);
      expect(repository.getSchemaVersion()).toBe('1');
      expect(repository.get('missing')).toBeUndefined();
      repository.set('example', 'first');
      expect(repository.get('example')).toBe('first');
      const before = connection.client.prepare("SELECT updated_at FROM app_meta WHERE key='example'").get() as { updated_at: number };
      repository.set('example', 'second');
      expect(repository.get('example')).toBe('second');
      const after = connection.client.prepare("SELECT updated_at FROM app_meta WHERE key='example'").get() as { updated_at: number };
      expect(after.updated_at).toBeGreaterThan(before.updated_at);
    } finally { connection.close(); }
  });
});
