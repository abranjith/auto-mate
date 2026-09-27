// ---------------------------------------------------------------------------
// Registered run outputs (FEAT-109 TASK-002).
//
// A run's artifacts appear together or not at all: `insertMany` writes every
// row in ONE transaction. Ids are allocated explicitly by `allocateIds`
// because the id is part of the stored file path
// (`artifacts/{taskId}/{id}{ext}`), so the file can be moved to its final
// name before the row exists. Allocation, the moves, and the insert run
// synchronously in one turn of the event loop, so two runs settling at once
// cannot be handed the same id.
//
// There is deliberately no method that deletes one artifact: retention is the
// life of the task (D12), and a per-artifact delete belongs to the standalone
// library D08 defers. Rows go by cascade from `task`, `execution`, or
// `script_run`; the files go by `ArtifactSweeper`.
// ---------------------------------------------------------------------------

import { asc, count, desc, eq, sql } from 'drizzle-orm';
import { AutoMateError, RepositoryError } from '@automate/core';
import type { DatabaseConnection } from '../client';
import { artifact } from '../schema';

export type ArtifactRow = typeof artifact.$inferSelect;
/** A row to insert, with its pre-allocated id. */
export type NewArtifactRow = typeof artifact.$inferInsert & { readonly id: number };

/** Exclusive persistence boundary for `artifact`. */
export class ArtifactRepository {
  constructor(private readonly connection: DatabaseConnection) {}

  /**
   * The next `count` ids, above every id ever issued (AUTOINCREMENT never reuses one).
   * Not a reservation: call it and `insertMany` in the same synchronous section.
   * @param howMany How many ids to allocate.
   * @returns Consecutive ids.
   */
  allocateIds(howMany: number): number[] {
    const issued = this.read(() => {
      const sequence = this.connection.client.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'artifact'").get() as { seq: number } | undefined;
      const max = this.connection.db.select({ max: sql<number | null>`max(${artifact.id})` }).from(artifact).get();
      return Math.max(sequence?.seq ?? 0, max?.max ?? 0);
    });
    return Array.from({ length: howMany }, (_, index) => issued + index + 1);
  }

  /**
   * Insert a run's artifacts atomically.
   * @param rows Rows with pre-allocated ids.
   * @returns The stored rows, in input order.
   * @throws RepositoryError when any row violates a constraint; nothing is written in that case.
   */
  insertMany(rows: readonly NewArtifactRow[]): ArtifactRow[] {
    if (rows.length === 0) return [];
    try {
      return this.connection.db.transaction((tx) => rows.map((row) => tx.insert(artifact).values(row).returning().get()));
    } catch (cause) {
      if (cause instanceof AutoMateError) throw cause;
      throw new RepositoryError('The run\'s output files could not be recorded.', cause);
    }
  }

  getById(id: number): ArtifactRow | undefined {
    return this.read(() => this.connection.db.select().from(artifact).where(eq(artifact.id, id)).get());
  }

  /** A run's list: declared files first, each group in id order. */
  listByExecution(executionId: number): ArtifactRow[] {
    return this.read(() => this.connection.db.select().from(artifact).where(eq(artifact.executionId, executionId)).orderBy(desc(artifact.declared), asc(artifact.id)).all());
  }

  listByRun(scriptRunId: number): ArtifactRow[] {
    return this.read(() => this.connection.db.select().from(artifact).where(eq(artifact.scriptRunId, scriptRunId)).orderBy(desc(artifact.declared), asc(artifact.id)).all());
  }

  listByTask(taskId: number): ArtifactRow[] {
    return this.read(() => this.connection.db.select().from(artifact).where(eq(artifact.taskId, taskId)).orderBy(asc(artifact.id)).all());
  }

  countByTask(taskId: number): number {
    return this.read(() => this.connection.db.select({ n: count() }).from(artifact).where(eq(artifact.taskId, taskId)).get()?.n ?? 0);
  }

  private read<T>(action: () => T): T {
    try { return action(); } catch (cause) { throw new RepositoryError('The run\'s output files could not be read.', cause); }
  }
}
