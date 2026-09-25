import { asc, eq } from 'drizzle-orm';
import { RepositoryError, type FileFormat } from '@automate/core';
import type { DatabaseConnection } from '../client';
import { syntheticFixture } from '../schema';

export type SyntheticFixtureRow = typeof syntheticFixture.$inferSelect;
export interface NewSyntheticFixture {
  readonly uploadId: number;
  readonly filePath: string;
  readonly format: FileFormat;
  readonly sheetCount: number;
  readonly rowCount: number;
  readonly sampleRowCount: number;
  readonly byteSize: number;
  readonly sha256: string;
  readonly seed: string;
}

/** Exclusive persistence boundary for the synthetic stand-in data each execution tested against. */
export class SyntheticFixtureRepository {
  constructor(private readonly connection: DatabaseConnection, private readonly now: () => Date = () => new Date()) {}

  /** Record one fixture. A second fixture for the same upload in the same execution fails loudly. */
  record(executionId: number, fixture: NewSyntheticFixture): SyntheticFixtureRow {
    try { return this.connection.db.insert(syntheticFixture).values({ ...fixture, executionId, createdAt: this.now() }).returning().get(); }
    catch (cause) { throw new RepositoryError('The synthetic test data could not be recorded.', cause); }
  }

  /** Replace every fixture row of one execution atomically, matching a fresh materialization on disk. */
  replaceForExecution(executionId: number, fixtures: readonly NewSyntheticFixture[]): SyntheticFixtureRow[] {
    try {
      return this.connection.db.transaction((tx) => {
        tx.delete(syntheticFixture).where(eq(syntheticFixture.executionId, executionId)).run();
        return fixtures.map((fixture) => tx.insert(syntheticFixture).values({ ...fixture, executionId, createdAt: this.now() }).returning().get());
      });
    } catch (cause) { throw new RepositoryError('The synthetic test data could not be recorded.', cause); }
  }

  listByExecution(executionId: number): SyntheticFixtureRow[] {
    try { return this.connection.db.select().from(syntheticFixture).where(eq(syntheticFixture.executionId, executionId)).orderBy(asc(syntheticFixture.id)).all(); }
    catch (cause) { throw new RepositoryError('Synthetic test data could not be read.', cause); }
  }
}
