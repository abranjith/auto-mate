import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import type { AppPaths } from '../config/app-paths';
import { RepositoryError } from '@automate/core';

/** Open SQLite with WAL and foreign keys. @param paths Resolved database path. @returns The client, Drizzle wrapper, and idempotent close function. @throws RepositoryError on failure. */
export function openDatabase(paths: AppPaths) {
  try {
    const client = new DatabaseSync(paths.dbFile);
    client.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    const db = drizzle({ client });
    let closed = false;
    return {
      client, db,
      /** Release the underlying SQLite file handle; repeated calls have no effect. */
      close() {
        if (closed) return;
        client.close();
        closed = true;
      },
    };
  } catch (cause) {
    throw new RepositoryError('The application database could not be opened.', cause);
  }
}

export type DatabaseConnection = ReturnType<typeof openDatabase>;
