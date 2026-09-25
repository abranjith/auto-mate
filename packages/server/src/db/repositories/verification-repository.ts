// ---------------------------------------------------------------------------
// Verification persistence (FEAT-107 TASK-003).
//
// A pass is opened `running`, then settled ONCE: its checks, their findings,
// the blocking/advisory counts, and its status are written in one transaction,
// so a crash can never leave a `passed` run with half its findings. Every key
// in `CHECK_KEYS` is written on every settled pass — a check that did not run
// is stored `skipped`, never omitted, because an absent row and a passed check
// must never look alike.
// ---------------------------------------------------------------------------

import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  AutoMateError,
  CHECK_KEYS,
  ERROR_CODES,
  RepositoryError,
  type CheckKey,
  type CheckStatus,
  type FindingConfidence,
  type FindingSeverity,
  type RuntimeDetail,
  type VerificationStatus,
} from '@automate/core';
import type { DatabaseConnection } from '../client';
import { isUniqueViolation } from './constraint';
import { verificationCheck, verificationFinding, verificationRun } from '../schema';

export type VerificationRunRow = typeof verificationRun.$inferSelect;
export type VerificationCheckRow = typeof verificationCheck.$inferSelect;
export type VerificationFindingRow = typeof verificationFinding.$inferSelect;
export interface VerificationRunWithChecks extends VerificationRunRow {
  readonly checks: readonly VerificationCheckRow[];
  readonly findings: readonly (VerificationFindingRow & { readonly checkKey: CheckKey })[];
}

/** One finding as a check produced it, before it has an id. */
export interface NewFinding {
  readonly ruleCode: string;
  readonly severity: FindingSeverity;
  readonly confidence: FindingConfidence | null;
  readonly filePath: string | null;
  readonly line: number | null;
  readonly column: number | null;
  readonly message: string;
  readonly isBlocking: boolean;
}

/** One check's settled result. */
export interface NewCheck {
  readonly checkKey: CheckKey;
  readonly status: CheckStatus;
  readonly isBlocking: boolean;
  readonly summary: string;
  readonly detail?: unknown;
  readonly durationMs: number | null;
  readonly findings: readonly NewFinding[];
}

export interface OpenVerification {
  readonly executionId: number;
  readonly codeVersionId: number;
  readonly contentDigest: string;
  readonly runtimeFingerprint: string;
  readonly runtimeDetail: RuntimeDetail;
}

export interface SettleVerification {
  readonly status: Exclude<VerificationStatus, 'running'>;
  readonly summary: string;
  readonly durationMs: number;
  readonly checks: readonly NewCheck[];
}

type Tx = Parameters<Parameters<DatabaseConnection['db']['transaction']>[0]>[0];

/** A check that never ran, stored so the key is present. */
export function skippedCheck(checkKey: CheckKey, summary = 'Not run.'): NewCheck {
  return { checkKey, status: 'skipped', isBlocking: false, summary, durationMs: null, findings: [] };
}

/** Exclusive persistence boundary for verification passes, checks, and findings. */
export class VerificationRepository {
  constructor(private readonly connection: DatabaseConnection, private readonly now: () => Date = () => new Date()) {}

  /**
   * Open a running pass for one (code version, runtime) pair.
   * @throws AutoMateError `VALIDATION_ERROR` when that pair already has a pass: a result that was true about a runtime is never overwritten.
   */
  open(input: OpenVerification): VerificationRunRow {
    try {
      return this.connection.db.insert(verificationRun).values({ ...input, runtimeDetail: JSON.stringify(input.runtimeDetail), startedAt: this.now(), createdAt: this.now() }).returning().get();
    } catch (cause) {
      if (isUniqueViolation(cause)) throw new AutoMateError(ERROR_CODES.VALIDATION_ERROR, 'This exact code has already been checked on this exact runtime, and that result stands.');
      throw new RepositoryError('The verification could not be started.', cause);
    }
  }

  /**
   * Write every check, its findings, the counts, and the status in one transaction.
   * Keys the caller did not supply are written `skipped`.
   */
  settle(runId: number, result: SettleVerification): VerificationRunWithChecks {
    this.write('settled', () => this.connection.db.transaction((tx) => {
      const supplied = new Map(result.checks.map((check) => [check.checkKey, check]));
      let blocking = 0;
      let advisory = 0;
      for (const key of CHECK_KEYS) {
        const check = supplied.get(key) ?? skippedCheck(key);
        this.writeCheck(tx, runId, check);
        blocking += check.findings.filter(({ isBlocking }) => isBlocking).length;
        advisory += check.findings.filter(({ isBlocking }) => !isBlocking).length;
      }
      tx.update(verificationRun).set({ status: result.status, summary: result.summary, durationMs: result.durationMs, blockingCount: blocking, advisoryCount: advisory, settledAt: this.now() }).where(and(eq(verificationRun.id, runId), eq(verificationRun.status, 'running'))).run();
    }));
    return this.getWithChecks(runId)!;
  }

  /** Write one check and its findings inside a caller's transaction. */
  writeCheck(tx: Tx, runId: number, check: NewCheck): VerificationCheckRow {
    const row = tx.insert(verificationCheck).values({ verificationRunId: runId, checkKey: check.checkKey, status: check.status, isBlocking: check.isBlocking, summary: check.summary, detail: check.detail === undefined ? null : JSON.stringify(check.detail), durationMs: check.durationMs, createdAt: this.now() }).returning().get();
    this.writeFindings(tx, row.id, check.findings);
    return row;
  }

  /** Write a check's findings inside a caller's transaction. */
  writeFindings(tx: Tx, checkId: number, findings: readonly NewFinding[]): void {
    for (const finding of findings) tx.insert(verificationFinding).values({ checkId, ...finding, createdAt: this.now() }).run();
  }

  /** Settle every pass of an execution still marked running as `aborted`, with every key present. @returns How many were settled. */
  abortRunning(executionId: number, summary = 'Checking was stopped before it finished.'): number {
    const running = this.read(() => this.connection.db.select().from(verificationRun).where(and(eq(verificationRun.executionId, executionId), eq(verificationRun.status, 'running'))).all());
    for (const row of running) this.settle(row.id, { status: 'aborted', summary, durationMs: Math.max(0, this.now().getTime() - row.startedAt.getTime()), checks: [] });
    return running.length;
  }

  /**
   * Remove a pass that did not reach a verdict — `aborted`, `timed_out`, or `errored` — so the same
   * (code, runtime) pair can be checked again. A `passed` or `failed` pass is a fact about that code on
   * that runtime and is never removed.
   * @returns Whether a row was removed.
   */
  discardInconclusive(id: number): boolean {
    return this.write('discarded', () => this.connection.db.delete(verificationRun).where(and(eq(verificationRun.id, id), inArray(verificationRun.status, ['aborted', 'timed_out', 'errored']))).returning().all().length > 0);
  }

  /** The pass for exactly this code and this runtime, if one exists. */
  findByScope(codeVersionId: number, runtimeFingerprint: string): VerificationRunRow | undefined {
    return this.read(() => this.connection.db.select().from(verificationRun).where(and(eq(verificationRun.codeVersionId, codeVersionId), eq(verificationRun.runtimeFingerprint, runtimeFingerprint))).get());
  }

  /** An execution's most recent pass. */
  getLatest(executionId: number): VerificationRunRow | undefined {
    return this.read(() => this.connection.db.select().from(verificationRun).where(eq(verificationRun.executionId, executionId)).orderBy(desc(verificationRun.id)).get());
  }

  getById(id: number): VerificationRunRow | undefined {
    return this.read(() => this.connection.db.select().from(verificationRun).where(eq(verificationRun.id, id)).get());
  }

  /** A pass with its checks in `CHECK_KEYS` order and every finding tagged with its check key. */
  getWithChecks(id: number): VerificationRunWithChecks | undefined {
    const run = this.getById(id);
    if (!run) return undefined;
    const checks = this.read(() => this.connection.db.select().from(verificationCheck).where(eq(verificationCheck.verificationRunId, id)).all());
    checks.sort((left, right) => CHECK_KEYS.indexOf(left.checkKey as CheckKey) - CHECK_KEYS.indexOf(right.checkKey as CheckKey));
    const keyOf = new Map(checks.map((check) => [check.id, check.checkKey as CheckKey]));
    const findings = checks.length === 0 ? [] : this.read(() => this.connection.db.select().from(verificationFinding).where(inArray(verificationFinding.checkId, checks.map(({ id: checkId }) => checkId))).orderBy(verificationFinding.id).all());
    return { ...run, checks, findings: findings.map((finding) => ({ ...finding, checkKey: keyOf.get(finding.checkId)! })) };
  }

  private read<T>(action: () => T): T {
    try { return action(); } catch (cause) { if (cause instanceof AutoMateError) throw cause; throw new RepositoryError('Verification results could not be read.', cause); }
  }
  private write<T>(verb: string, action: () => T): T {
    try { return action(); } catch (cause) { if (cause instanceof AutoMateError) throw cause; throw new RepositoryError(`The verification could not be ${verb}.`, cause); }
  }
}
