// ---------------------------------------------------------------------------
// Pre-run approvals (FEAT-107 TASK-003/010).
//
// An approval and the state change it causes are ONE fact: `decide` inserts
// the row and moves the execution in the same transaction, so an approval
// that did not move the execution cannot exist, and a failed transition leaves
// no approval behind. The partial unique index allows exactly one `approved`
// row per execution.
// ---------------------------------------------------------------------------

import { and, asc, eq } from 'drizzle-orm';
import { AutoMateError, ERROR_CODES, ExecutionNotApprovedError, RepositoryError, applyTransition, type ExecutionStatus } from '@automate/core';
import type { DatabaseConnection } from '../client';
import { isUniqueViolation } from './constraint';
import { execution, executionApproval } from '../schema';

export type ExecutionApprovalRow = typeof executionApproval.$inferSelect;

export interface NewApproval {
  readonly executionId: number;
  readonly codeVersionId: number;
  readonly verificationRunId: number;
  readonly contentDigest: string;
  readonly runtimeFingerprint: string;
  readonly intentDigest: string;
  readonly decision: 'approved' | 'cancelled';
  readonly acknowledgedWarnings: boolean;
}

/** Exclusive persistence boundary for `execution_approval`. */
export class ApprovalRepository {
  constructor(private readonly connection: DatabaseConnection, private readonly now: () => Date = () => new Date()) {}

  /**
   * Record a decision and move the execution from `awaiting_approval`, atomically.
   * @param input The decision and exactly what it binds to.
   * @param next `executing` for an approval, `aborted` for a cancellation.
   * @throws ExecutionNotApprovedError when the execution is not awaiting approval; AutoMateError `VALIDATION_ERROR` for a second approval.
   */
  decide(input: NewApproval, next: Extract<ExecutionStatus, 'executing' | 'aborted'>): ExecutionApprovalRow {
    try {
      return this.connection.db.transaction((tx) => {
        const current = tx.select().from(execution).where(eq(execution.id, input.executionId)).get();
        if (!current || current.status !== 'awaiting_approval') throw new ExecutionNotApprovedError(input.executionId, current?.status);
        applyTransition(current.status as ExecutionStatus, next);
        const decidedAt = this.now();
        const row = tx.insert(executionApproval).values({ ...input, decidedAt, createdAt: decidedAt }).returning().get();
        const settled = next === 'aborted' ? { completedAt: decidedAt, durationMs: current.startedAt ? Math.max(0, decidedAt.getTime() - current.startedAt.getTime()) : 0 } : {};
        tx.update(execution).set({ status: next, ...settled }).where(eq(execution.id, input.executionId)).run();
        return row;
      });
    } catch (cause) {
      if (cause instanceof AutoMateError) throw cause;
      if (isUniqueViolation(cause)) throw new AutoMateError(ERROR_CODES.VALIDATION_ERROR, 'This run was already approved; it cannot be approved twice.');
      throw new RepositoryError('The decision could not be saved.', cause);
    }
  }

  /** The one `approved` decision for an execution, if any. */
  getGranted(executionId: number): ExecutionApprovalRow | undefined {
    return this.read(() => this.connection.db.select().from(executionApproval).where(and(eq(executionApproval.executionId, executionId), eq(executionApproval.decision, 'approved'))).get());
  }

  /** Every decision for an execution, oldest first. */
  listByExecution(executionId: number): ExecutionApprovalRow[] {
    return this.read(() => this.connection.db.select().from(executionApproval).where(eq(executionApproval.executionId, executionId)).orderBy(asc(executionApproval.id)).all());
  }

  private read<T>(action: () => T): T {
    try { return action(); } catch (cause) { throw new RepositoryError('Approvals could not be read.', cause); }
  }
}
