import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { AutoMateError, RepositoryError, type AttemptStatus, type RefusalReason } from '@automate/core';
import type { DatabaseConnection } from '../client';
import { generationAttempt } from '../schema';

export type GenerationAttemptRow = typeof generationAttempt.$inferSelect;
export interface AttemptSettlement {
  readonly status: Exclude<AttemptStatus, 'running' | 'refused'>;
  readonly testsTotal?: number | null;
  readonly testsPassed?: number | null;
  readonly testsFailed?: number | null;
  readonly exitCode?: number | null;
  readonly manifestPresent?: boolean | null;
  readonly diagnosticDigest?: string | null;
  readonly droppedLineCount?: number | null;
  readonly durationMs?: number | null;
}

/**
 * Exclusive persistence boundary for `run_tests` invocations. This table is
 * the attempt limit: `countUsed` reads it from the database on every claim, so
 * a restart cannot reset the budget.
 */
export class GenerationAttemptRepository {
  constructor(private readonly connection: DatabaseConnection, private readonly now: () => Date = () => new Date()) {}

  /** Open a running attempt for one sealed version. A duplicate call id or attempt number fails loudly. */
  open(input: { readonly executionId: number; readonly codeVersionId: number; readonly attempt: number; readonly callId: string | null }): GenerationAttemptRow {
    return this.write('opened', () => this.connection.db.insert(generationAttempt).values({ ...input, status: 'running', startedAt: this.now(), createdAt: this.now() }).returning().get());
  }

  /** Settle a running attempt exactly once. */
  settle(id: number, outcome: AttemptSettlement): GenerationAttemptRow {
    return this.write('settled', () => {
      const row = this.connection.db.update(generationAttempt).set({ ...outcome, settledAt: this.now() }).where(and(eq(generationAttempt.id, id), eq(generationAttempt.status, 'running'))).returning().get();
      if (!row) throw new RepositoryError('The attempt was already settled.');
      return row;
    });
  }

  /** Record a refusal: a recorded, rendered outcome that consumes no attempt and seals no version. */
  refuse(input: { readonly executionId: number; readonly attempt: number; readonly callId: string | null; readonly reason: RefusalReason }): GenerationAttemptRow {
    const at = this.now();
    return this.write('recorded', () => this.connection.db.insert(generationAttempt).values({ executionId: input.executionId, attempt: input.attempt, callId: input.callId, status: 'refused', refusalReason: input.reason, startedAt: at, settledAt: at, createdAt: at }).returning().get());
  }

  /** Attempts that count against the limit: every row except refusals. */
  countUsed(executionId: number): number {
    return this.read(() => this.connection.db.select({ value: sql<number>`count(*)` }).from(generationAttempt).where(and(eq(generationAttempt.executionId, executionId), ne(generationAttempt.status, 'refused'))).get()?.value ?? 0);
  }

  /** Settle any attempt a crash or cancellation left running as `aborted`. */
  abortRunning(executionId: number): number {
    return this.write('settled', () => this.connection.db.update(generationAttempt).set({ status: 'aborted', settledAt: this.now() }).where(and(eq(generationAttempt.executionId, executionId), eq(generationAttempt.status, 'running'))).returning().all().length);
  }

  listByExecution(executionId: number): GenerationAttemptRow[] {
    return this.read(() => this.connection.db.select().from(generationAttempt).where(eq(generationAttempt.executionId, executionId)).orderBy(asc(generationAttempt.attempt)).all());
  }

  getByCallId(callId: string): GenerationAttemptRow | undefined {
    return this.read(() => this.connection.db.select().from(generationAttempt).where(eq(generationAttempt.callId, callId)).get());
  }

  /** The attempt row recorded at one number, if any. */
  getByNumber(executionId: number, attempt: number): GenerationAttemptRow | undefined {
    return this.read(() => this.connection.db.select().from(generationAttempt).where(and(eq(generationAttempt.executionId, executionId), eq(generationAttempt.attempt, attempt))).get());
  }

  private read<T>(action: () => T): T {
    try { return action(); } catch (cause) { if (cause instanceof AutoMateError) throw cause; throw new RepositoryError('Generation attempts could not be read.', cause); }
  }
  private write<T>(verb: string, action: () => T): T {
    try { return action(); } catch (cause) { if (cause instanceof AutoMateError) throw cause; throw new RepositoryError(`The generation attempt could not be ${verb}.`, cause); }
  }
}
