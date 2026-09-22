import { eq, sql } from 'drizzle-orm';
import { RepositoryError } from '@automate/core';
import type { DatabaseConnection } from '../client';
import { appMeta } from '../schema';

/** Exclusive data access path for application metadata. */
export class AppMetaRepository {
  constructor(private readonly connection: DatabaseConnection) {}

  /** Read a metadata value. @param key Metadata key. @returns Its value or undefined when absent. */
  get(key: string): string | undefined {
    try {
      return this.connection.db.select().from(appMeta).where(eq(appMeta.key, key)).get()?.value;
    } catch (cause) {
      throw new RepositoryError('Application metadata could not be read.', cause);
    }
  }

  /** Insert or replace metadata. @param key Metadata key. @param value Text value. @returns Nothing; advances the update timestamp. */
  set(key: string, value: string): void {
    try {
      this.connection.db.insert(appMeta).values({ key, value }).onConflictDoUpdate({
        target: appMeta.key,
        set: { value, updatedAt: sql`max(${appMeta.updatedAt} + 1, unixepoch())` },
      }).run();
    } catch (cause) {
      throw new RepositoryError('Application metadata could not be saved.', cause);
    }
  }

  /** Read the current migrated schema version. @returns The version string, or unknown when absent. */
  getSchemaVersion(): string {
    return this.get('schema_version') ?? 'unknown';
  }
}
