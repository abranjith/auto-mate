// ---------------------------------------------------------------------------
// The real-data run (FEAT-107 TASK-003/011).
//
// `openGated` is THE ONLY WAY a `script_run` row comes into existence, and it
// performs the gate as a database operation: inside one transaction it reads
// the `approved` approval and compares its code digest and runtime fingerprint
// against the ones about to run — two stored facts compared, not a boolean
// passed down a call stack. Any mismatch throws and writes nothing; the caller
// spawns only after this returns, so a stale approval produces zero processes.
//
// `stdout`/`stderr` may contain values from the person's real file. They are
// stored here per memory's logging rule, never logged, and reach a prompt only
// through FEAT-105's `recordDiagnosticTransmission`.
// ---------------------------------------------------------------------------

import { and, eq } from 'drizzle-orm';
import { ApprovalStaleError, AutoMateError, ERROR_CODES, ExecutionNotApprovedError, RepositoryError, evaluateApproval, type LimitBreach, type ScriptRunStatus } from '@automate/core';
import type { DatabaseConnection } from '../client';
import { isUniqueViolation } from './constraint';
import { executionApproval, scriptRun } from '../schema';

export type ScriptRunRow = typeof scriptRun.$inferSelect;

/** One staged input: exactly which bytes were copied in. */
export interface StagedInput {
  readonly uploadId: number;
  readonly storedFilename: string;
  readonly sha256: string;
  readonly byteSize: number;
}

export interface OpenGatedRun {
  readonly executionId: number;
  readonly codeVersionId: number;
  readonly contentDigest: string;
  /** Re-probed immediately before the run; never copied from the approval. */
  readonly runtimeFingerprint: string;
  readonly dirPath: string;
  readonly inputs: readonly StagedInput[];
}

export interface SettleRun {
  readonly status: Exclude<ScriptRunStatus, 'running'>;
  readonly exitCode: number | null;
  readonly stdout: string | null;
  readonly stderr: string | null;
  readonly outputTruncated: boolean;
  readonly manifestPresent: boolean | null;
  readonly manifestJson: string | null;
  readonly declaredOutputCount: number | null;
  readonly producedOutputCount: number | null;
  readonly durationMs: number;
  readonly outputByteCount?: number | null;
  readonly limitBreached?: LimitBreach | null;
  readonly runtimeLockDigest?: string | null;
}

/** Exclusive persistence boundary for `script_run`. */
export class ScriptRunRepository {
  constructor(private readonly connection: DatabaseConnection, private readonly now: () => Date = () => new Date()) {}

  /**
   * Insert a run row only if the stored approval covers exactly this code and runtime.
   * @throws ExecutionNotApprovedError when no `approved` approval exists; ApprovalStaleError when the digest or the fingerprint differs. Writes nothing in either case.
   */
  openGated(request: OpenGatedRun): ScriptRunRow {
    try {
      return this.connection.db.transaction((tx) => {
        const approval = tx.select().from(executionApproval).where(and(eq(executionApproval.executionId, request.executionId), eq(executionApproval.decision, 'approved'))).get();
        if (!approval) throw new ExecutionNotApprovedError(request.executionId);
        const staleness = evaluateApproval({ ...approval, decision: 'approved' }, { contentDigest: request.contentDigest, runtimeFingerprint: request.runtimeFingerprint, intentDigest: approval.intentDigest });
        if (staleness === 'digest' || staleness === 'runtime') throw new ApprovalStaleError(staleness);
        if (approval.codeVersionId !== request.codeVersionId) throw new ApprovalStaleError('digest');
        const startedAt = this.now();
        return tx.insert(scriptRun).values({ executionId: request.executionId, codeVersionId: request.codeVersionId, approvalId: approval.id, contentDigest: request.contentDigest, runtimeFingerprint: request.runtimeFingerprint, dirPath: request.dirPath, inputManifest: JSON.stringify(request.inputs), startedAt, createdAt: startedAt }).returning().get();
      });
    } catch (cause) {
      if (cause instanceof AutoMateError) throw cause;
      if (isUniqueViolation(cause)) throw new AutoMateError(ERROR_CODES.VALIDATION_ERROR, 'This run has already been started once; a rejected result starts a new run instead.');
      throw new RepositoryError('The run could not be started.', cause);
    }
  }

  /** Record how the run ended. Only a running row settles. */
  settle(id: number, result: SettleRun): ScriptRunRow {
    if (result.limitBreached === 'time' && result.status !== 'timed_out') throw new AutoMateError(ERROR_CODES.VALIDATION_ERROR, 'A time limit breach must settle the run as timed out.');
    try {
      const row = this.connection.db.update(scriptRun).set({ ...result, settledAt: this.now() }).where(and(eq(scriptRun.id, id), eq(scriptRun.status, 'running'))).returning().get();
      return row ?? this.getById(id)!;
    } catch (cause) {
      throw new RepositoryError('The run result could not be saved.', cause);
    }
  }

  /** Settle an execution's run still marked running as `aborted`. @returns Whether one was settled. */
  abortRunning(executionId: number): boolean {
    const row = this.getByExecution(executionId);
    if (!row || row.status !== 'running') return false;
    this.settle(row.id, { status: 'aborted', exitCode: null, stdout: null, stderr: null, outputTruncated: false, manifestPresent: null, manifestJson: null, declaredOutputCount: null, producedOutputCount: null, durationMs: Math.max(0, this.now().getTime() - row.startedAt.getTime()) });
    return true;
  }

  getById(id: number): ScriptRunRow | undefined {
    return this.read(() => this.connection.db.select().from(scriptRun).where(eq(scriptRun.id, id)).get());
  }

  /** The execution's one run, if it has started. */
  getByExecution(executionId: number): ScriptRunRow | undefined {
    return this.read(() => this.connection.db.select().from(scriptRun).where(eq(scriptRun.executionId, executionId)).get());
  }

  private read<T>(action: () => T): T {
    try { return action(); } catch (cause) { throw new RepositoryError('The run could not be read.', cause); }
  }
}
