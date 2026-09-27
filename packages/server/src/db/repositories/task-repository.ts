import { eq } from 'drizzle-orm';
import { AutoMateError, RepositoryError, TERMINAL_STATUSES, TaskHasOpenRunError, TaskNotFoundError, type ExecutionStatus } from '@automate/core';
import type { DatabaseConnection } from '../client';
import { artifact, execution, task, upload } from '../schema';
import { asOfColumns, newAsOf } from '../../execution/as-of-storage';
import type { AsOf } from '@automate/core';

type Tx = Parameters<Parameters<DatabaseConnection['db']['transaction']>[0]>[0];

export type TaskRow = typeof task.$inferSelect;

/** Derive a stable display name from the first useful prompt line. */
export function deriveTaskName(prompt: string): string {
  const line =
    prompt
      .split(/\r?\n/)
      .map((part) => part.trim())
      .find(Boolean) ?? '';
  const collapsed = line.replace(/\s+/g, ' ').replace(/^[\p{P}\p{S}\s]+$/u, '');
  if (!collapsed) return 'Untitled task';
  return collapsed.length <= 80 ? collapsed : `${collapsed.slice(0, 79)}…`;
}

/** Exclusive data-access path for task definitions. */
export class TaskRepository {
  constructor(private readonly connection: DatabaseConnection) {}

  /** Create a saved-task run and every related row in one outer transaction. */
  createNamedWithExecution(name: string, description: string, asOf: AsOf, within: (tx: Tx, taskId: number, executionId: number) => void, guidance?: string | null) {
    return this.connection.db.transaction((tx) => {
      const createdTask = tx.insert(task).values({ name, description }).returning().get();
      const createdExecution = tx.insert(execution).values({ taskId: createdTask.id, guidance: guidance ?? null, ...asOfColumns(asOf) }).returning().get();
      within(tx, createdTask.id, createdExecution.id);
      return { task: createdTask, execution: createdExecution };
    });
  }

  /**
   * Remove a whole task's rows in one transaction: the task row goes and SQLite's
   * cascades remove everything it owns. The open-run check runs inside the same
   * transaction, so a retry committed after an earlier check cannot slip through.
   * This repository never touches the filesystem; `TaskDeletionService` removes
   * the task's files after this commits (rows first, files second).
   *
   * @param taskId The task to delete.
   * @returns The deleted execution ids, for the file trees keyed by execution, and the counts removed.
   * @throws TaskNotFoundError when no such task exists; TaskHasOpenRunError when a run is not terminal.
   */
  deleteOwnedRows(taskId: number): { executionIds: number[]; counts: { runs: number; inputs: number; outputs: number } } {
    try {
      return this.connection.db.transaction((tx) => {
        const existing = tx.select({ id: task.id }).from(task).where(eq(task.id, taskId)).get();
        if (!existing) throw new TaskNotFoundError(taskId);
        const rows = tx.select({ id: execution.id, status: execution.status }).from(execution).where(eq(execution.taskId, taskId)).all();
        const open = rows.find((row) => !(TERMINAL_STATUSES as readonly string[]).includes(row.status));
        if (open) throw new TaskHasOpenRunError(open.id, open.status as ExecutionStatus);
        const inputs = tx.select({ id: upload.id }).from(upload).where(eq(upload.taskId, taskId)).all().length;
        const outputs = tx.select({ id: artifact.id }).from(artifact).where(eq(artifact.taskId, taskId)).all().length;
        tx.delete(task).where(eq(task.id, taskId)).run();
        return { executionIds: rows.map((row) => row.id), counts: { runs: rows.length, inputs, outputs } };
      });
    } catch (cause) {
      if (cause instanceof AutoMateError) throw cause;
      throw new RepositoryError('The task could not be deleted.', cause);
    }
  }

  /** Create a task. */
  create(input: { name: string; description: string }): TaskRow {
    try {
      return this.connection.db.insert(task).values(input).returning().get();
    } catch (cause) {
      throw new RepositoryError('The task could not be saved.', cause);
    }
  }

  /**
   * Create the task and its first execution atomically.
   *
   * @param description The person's words, verbatim.
   * @param withinTransaction Runs inside the same transaction once the task exists (FEAT-104 attaches uploads here); throwing rolls everything back.
   * @returns The task and its execution.
   */
  createWithExecution(description: string, withinTransaction?: (taskId: number, executionId: number, tx: Tx) => void, timeZone?: string): {
    task: TaskRow;
    execution: typeof execution.$inferSelect;
  } {
    try {
      return this.connection.db.transaction((tx) => {
        const createdTask = tx
          .insert(task)
          .values({ name: deriveTaskName(description), description })
          .returning()
          .get();
        const createdExecution = tx
          .insert(execution)
          .values({ taskId: createdTask.id, ...asOfColumns(newAsOf(new Date(), timeZone)) })
          .returning()
          .get();
        withinTransaction?.(createdTask.id, createdExecution.id, tx);
        return { task: createdTask, execution: createdExecution };
      });
    } catch (cause) {
      if (cause instanceof AutoMateError) throw cause;
      throw new RepositoryError('The task could not be created.', cause);
    }
  }

  /** Read one task by id. */
  getById(id: number): TaskRow | undefined {
    try {
      return this.connection.db
        .select()
        .from(task)
        .where(eq(task.id, id))
        .get();
    } catch (cause) {
      throw new RepositoryError('The task could not be read.', cause);
    }
  }
}
