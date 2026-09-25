import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { RepositoryError } from '@automate/core';
import type { DatabaseConnection } from './client';

/** The committed migrations shipped with the server. */
export const MIGRATIONS_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

/** Apply committed migrations in-process. @param connection Open SQLite connection. @param migrationsFolder Override for tests that replay a prefix of the history. @returns Nothing; modifies database schema only when needed. @throws RepositoryError on failure. */
export function migrateDatabase(connection: DatabaseConnection, migrationsFolder = MIGRATIONS_FOLDER): void {
  try {
    const result = migrate(connection.db, { migrationsFolder });
    if (result && typeof result === 'object') throw new Error('Migration initialization failed');
  } catch (cause) {
    throw new RepositoryError('The application database could not be updated.', cause);
  }
}
