import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { RepositoryError } from '@automate/core';
import type { DatabaseConnection } from './client';

/** Apply committed migrations in-process. @param connection Open SQLite connection. @returns Nothing; modifies database schema only when needed. @throws RepositoryError on failure. */
export function migrateDatabase(connection: DatabaseConnection): void {
  const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');
  try {
    const result = migrate(connection.db, { migrationsFolder });
    if (result && typeof result === 'object') throw new Error('Migration initialization failed');
  } catch (cause) {
    throw new RepositoryError('The application database could not be updated.', cause);
  }
}
