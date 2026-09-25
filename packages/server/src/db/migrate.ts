import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { RepositoryError } from '@automate/core';
import type { DatabaseConnection } from './client';

/** The committed migrations shipped with the server. */
export const MIGRATIONS_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

/**
 * Apply committed migrations in-process.
 *
 * Foreign keys are switched OFF around the migrator, not inside a migration:
 * drizzle wraps every pending migration in one `BEGIN`, and SQLite ignores
 * `PRAGMA foreign_keys` inside a transaction. With them still on, a table
 * rebuild's `DROP TABLE` performs an implicit `DELETE` that fires every
 * `ON DELETE CASCADE` — rebuilding `execution` (FEAT-107) would silently
 * empty every child table. This is step 1 of SQLite's documented 12-step
 * procedure; the migration itself ends with a `foreign_key_check` guard.
 *
 * @param connection Open SQLite connection.
 * @param migrationsFolder Override for tests that replay a prefix of the history.
 * @returns Nothing; modifies database schema only when needed.
 * @throws RepositoryError on failure; foreign keys are re-enabled either way.
 */
export function migrateDatabase(connection: DatabaseConnection, migrationsFolder = MIGRATIONS_FOLDER): void {
  connection.client.exec('PRAGMA foreign_keys = OFF;');
  try {
    const result = migrate(connection.db, { migrationsFolder });
    if (result && typeof result === 'object') throw new Error('Migration initialization failed');
  } catch (cause) {
    throw new RepositoryError('The application database could not be updated.', cause);
  } finally {
    connection.client.exec('PRAGMA foreign_keys = ON;');
  }
}
