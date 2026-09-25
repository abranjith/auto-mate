import { eq, inArray } from 'drizzle-orm';
import {
  RepositoryError,
  applyTransition,
  type AgentUsage,
  type ExecutionStatus,
} from '@automate/core';
import type { DatabaseConnection } from '../client';
import { execution } from '../schema';

export type ExecutionRow = typeof execution.$inferSelect;
const ACTIVE: ExecutionStatus[] = [
  'pending',
  'generating',
  'verifying',
  'executing',
  'waiting',
];

/** Exclusive data-access path for execution state and provenance. */
export class ExecutionRepository {
  constructor(
    private readonly connection: DatabaseConnection,
    private readonly now: () => Date = () => new Date(),
  ) {}
  create(taskId: number): ExecutionRow {
    return this.write('created', () =>
      this.connection.db.insert(execution).values({ taskId }).returning().get(),
    );
  }
  /**
   * Create a guidance retry of an existing run (FEAT-106): same task, `trigger = 'rerun'`, linked back to its source.
   * The source row is never touched; the failed run stays failed and readable.
   * @param fromExecutionId The run being retried.
   * @param guidance The person's hint, or null.
   * @returns The new pending execution.
   */
  createRetry(fromExecutionId: number, guidance: string | null): ExecutionRow {
    return this.write('created', () => this.connection.db.transaction((tx) => {
      const source = tx.select().from(execution).where(eq(execution.id, fromExecutionId)).get();
      if (!source) throw new RepositoryError('The execution could not be found.');
      return tx.insert(execution).values({ taskId: source.taskId, trigger: 'rerun', retryOfExecutionId: source.id, guidance }).returning().get();
    }));
  }
  /**
   * Follow retry links back to the first run.
   * @param executionId Any run in a chain.
   * @returns The chain oldest-first, ending with `executionId`; empty when it does not exist.
   */
  getRetryChain(executionId: number): ExecutionRow[] {
    const chain: ExecutionRow[] = [];
    const seen = new Set<number>();
    let current = this.getById(executionId);
    while (current && !seen.has(current.id)) {
      chain.unshift(current);
      seen.add(current.id);
      current = current.retryOfExecutionId === null ? undefined : this.getById(current.retryOfExecutionId);
    }
    return chain;
  }
  getById(id: number): ExecutionRow | undefined {
    return this.read(() =>
      this.connection.db
        .select()
        .from(execution)
        .where(eq(execution.id, id))
        .get(),
    );
  }
  listByTask(taskId: number): ExecutionRow[] {
    return this.read(() =>
      this.connection.db
        .select()
        .from(execution)
        .where(eq(execution.taskId, taskId))
        .all(),
    );
  }
  listActive(): ExecutionRow[] {
    return this.read(() =>
      this.connection.db
        .select()
        .from(execution)
        .where(inArray(execution.status, ACTIVE))
        .all(),
    );
  }

  markStarted(id: number): ExecutionRow {
    return this.transition(id, 'generating', { startedAt: this.now() });
  }
  /** Move an active execution across an explicitly allowed state edge. */
  transitionStatus(id: number, status: ExecutionStatus): ExecutionRow {
    return this.transition(id, status, {});
  }
  markSessionOpened(
    id: number,
    value: {
      sessionId: string;
      logPath: string;
      provider: string;
      model: string;
    },
  ): ExecutionRow {
    return this.update(id, {
      agentSessionId: value.sessionId,
      agentLogPath: value.logPath,
      provider: value.provider,
      model: value.model,
    });
  }
  markSettled(
    id: number,
    value: {
      status: Extract<ExecutionStatus, 'completed' | 'failed' | 'aborted'>;
      usage?: AgentUsage;
      errorCode?: string;
      errorMessage?: string;
    },
  ): ExecutionRow {
    const current = this.required(id);
    applyTransition(current.status as ExecutionStatus, value.status);
    const completedAt = this.now();
    return this.update(id, {
      status: value.status,
      completedAt,
      durationMs:
        current.startedAt === null
          ? 0
          : Math.max(0, completedAt.getTime() - current.startedAt.getTime()),
      usageTurns: value.usage?.turns ?? null,
      usageInputTokens: value.usage?.inputTokens ?? null,
      usageOutputTokens: value.usage?.outputTokens ?? null,
      usageCostUsd: value.usage?.costUsd ?? null,
      errorCode: value.errorCode ?? null,
      errorMessage: value.errorMessage ?? null,
    });
  }
  markInterrupted(id: number): ExecutionRow {
    const current = this.required(id);
    return this.markSettled(id, {
      status: 'failed',
      errorCode: 'EXECUTION_INTERRUPTED',
      errorMessage:
        current.status === 'waiting'
          ? 'This run was interrupted while waiting for your answer. Your answers were saved — start it again and you will not be asked twice.'
          : 'This run was interrupted when the server restarted. Start it again to retry.',
    });
  }

  private transition(
    id: number,
    status: ExecutionStatus,
    patch: Partial<typeof execution.$inferInsert>,
  ): ExecutionRow {
    const current = this.required(id);
    applyTransition(current.status as ExecutionStatus, status);
    return this.update(id, { ...patch, status });
  }
  private required(id: number): ExecutionRow {
    const row = this.getById(id);
    if (!row) throw new RepositoryError('The execution could not be found.');
    return row;
  }
  private update(
    id: number,
    patch: Partial<typeof execution.$inferInsert>,
  ): ExecutionRow {
    return this.write('updated', () =>
      this.connection.db
        .update(execution)
        .set(patch)
        .where(eq(execution.id, id))
        .returning()
        .get(),
    );
  }
  private read<T>(action: () => T): T {
    try {
      return action();
    } catch (cause) {
      if (cause instanceof RepositoryError) throw cause;
      throw new RepositoryError('Execution data could not be read.', cause);
    }
  }
  private write<T>(verb: string, action: () => T): T {
    try {
      return action();
    } catch (cause) {
      if (cause instanceof RepositoryError) throw cause;
      throw new RepositoryError(`The execution could not be ${verb}.`, cause);
    }
  }
}
