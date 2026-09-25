import { desc, eq, inArray } from 'drizzle-orm';
import {
  RepositoryError,
  applyTransition,
  type AgentUsage,
  type ExecutionStatus,
} from '@automate/core';
import type { DatabaseConnection } from '../client';
import { execution } from '../schema';

export type ExecutionRow = typeof execution.$inferSelect;
/**
 * What a restart interrupts: everything holding in-memory state. `waiting`
 * belongs here — its question lives in a live provider session (FEAT-105).
 * The two FEAT-107 gates do not: they are rows, and survive (`PARKED`).
 */
const ACTIVE: ExecutionStatus[] = [
  'pending',
  'generating',
  'verifying',
  'executing',
  'waiting',
];
/** Parked on a person with no in-memory state; served by the `execution_parked` index. */
const PARKED: ExecutionStatus[] = ['awaiting_approval', 'awaiting_review'];
type TerminalStatus = Extract<ExecutionStatus, 'completed' | 'failed' | 'aborted' | 'rejected'>;
const INTERRUPTED_MESSAGES: Partial<Record<ExecutionStatus, string>> = {
  waiting: 'This run was interrupted while waiting for your answer. Your answers were saved — start it again and you will not be asked twice.',
  verifying: 'This run was interrupted while its code was being checked. Start it again to retry.',
  executing: 'This run was interrupted while the script was running on your file. Start it again to retry.',
};

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
   * Create the new run a rejected result seeds (FEAT-107): same task, `trigger = 'feedback'`,
   * linked back, with the person's feedback as its guidance. The consent is the task's and is
   * reused as-is; the rejected run is never touched.
   * @param fromExecutionId The rejected run.
   * @param feedback What the person said was wrong.
   * @returns The new pending execution.
   */
  createFeedbackRetry(fromExecutionId: number, feedback: string): ExecutionRow {
    return this.write('created', () => this.connection.db.transaction((tx) => {
      const source = tx.select().from(execution).where(eq(execution.id, fromExecutionId)).get();
      if (!source) throw new RepositoryError('The execution could not be found.');
      return tx.insert(execution).values({ taskId: source.taskId, trigger: 'feedback', retryOfExecutionId: source.id, guidance: feedback }).returning().get();
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
  /** Executions waiting at the approval or review gate, most recent first. `waiting` is not parked here: it does not survive a restart. */
  listParked(): ExecutionRow[] {
    return this.read(() =>
      this.connection.db
        .select()
        .from(execution)
        .where(inArray(execution.status, PARKED))
        .orderBy(desc(execution.id))
        .all(),
    );
  }
  /**
   * Hand a run to its next phase without settling it (FEAT-107: `generating → verifying`).
   * Usage is recorded now because the provider session is over.
   */
  markHandedOff(id: number, status: Extract<ExecutionStatus, 'verifying'>, usage?: AgentUsage): ExecutionRow {
    return this.transition(id, status, {
      usageTurns: usage?.turns ?? null,
      usageInputTokens: usage?.inputTokens ?? null,
      usageOutputTokens: usage?.outputTokens ?? null,
      usageCostUsd: usage?.costUsd ?? null,
    });
  }
  /**
   * Record a person's verdict on a result: `awaiting_review → completed | rejected`.
   * @param feedback Stored only for a rejection.
   */
  markReviewed(id: number, verdict: 'accepted' | 'rejected', feedback: string | null): ExecutionRow {
    const current = this.required(id);
    const status = verdict === 'accepted' ? 'completed' : 'rejected';
    applyTransition(current.status as ExecutionStatus, status);
    const reviewedAt = this.now();
    return this.update(id, {
      status,
      reviewedAt,
      reviewFeedback: verdict === 'rejected' ? feedback : null,
      completedAt: reviewedAt,
      durationMs: current.startedAt === null ? 0 : Math.max(0, reviewedAt.getTime() - current.startedAt.getTime()),
    });
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
      status: TerminalStatus;
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
      errorMessage: INTERRUPTED_MESSAGES[current.status as ExecutionStatus] ?? 'This run was interrupted when the server restarted. Start it again to retry.',
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
