import { eq } from 'drizzle-orm';
import { AutoMateError, RepositoryError } from '@automate/core';
import type { DatabaseConnection } from '../client';
import { execution, task } from '../schema';

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
  createWithExecution(description: string, withinTransaction?: (taskId: number, executionId: number) => void): {
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
          .values({ taskId: createdTask.id })
          .returning()
          .get();
        withinTransaction?.(createdTask.id, createdExecution.id);
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
