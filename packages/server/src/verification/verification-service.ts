// ---------------------------------------------------------------------------
// `VerificationService` (FEAT-107 TASK-009): one pass, one verdict, bound to
// code AND runtime.
//
// A verification is a fact about one sealed version on one runtime, so a pass
// for an unchanged (version, fingerprint) pair is REUSED, never re-derived —
// re-running it would either agree or reveal a non-deterministic check. A
// changed runtime gets a new pass; the old one stays, true about the old
// runtime. The pass makes NO provider call: nothing here opens a session,
// builds a prompt, or sends anything to a model.
//
// Outcome: `verifying → awaiting_approval` when the gate allows the run, or
// `→ failed` with the verdict as a plain-English message when it does not. A
// blocked run is a recorded outcome, not an error, and it is retried through
// FEAT-106's existing guidance retry.
// ---------------------------------------------------------------------------

import path from 'node:path';
import {
  AutoMateError,
  CodeVersionNotFinalError,
  ERROR_CODES,
  ExecutionNotFoundError,
  VERIFICATION_TIMEOUT_MS,
  ValidationError,
  decideGate,
  describeRuntime,
  shortDigest,
  summarizeVerification,
  type ExecutionStatus,
  type VerificationStatus,
} from '@automate/core';
import type { Logger } from 'pino';
import { resolveWithin, type AppPaths } from '../config/app-paths';
import type { CodeVersionRepository, CodeVersionWithFiles } from '../db/repositories/code-version-repository';
import type { ExecutionRepository } from '../db/repositories/execution-repository';
import type { SyntheticFixtureRepository } from '../db/repositories/synthetic-fixture-repository';
import type { UploadProfileRepository } from '../db/repositories/upload-profile-repository';
import type { UploadRepository } from '../db/repositories/upload-repository';
import type { NewCheck, VerificationRepository, VerificationRunRow, VerificationRunWithChecks } from '../db/repositories/verification-repository';
import type { PhaseJob } from '../conversation/task-session-registry';
import type { ExecutionStateWriter } from './execution-state-writer';
import { presentVerification } from './presenters';
import type { ProbedRuntime, RuntimeProbe } from './runtime-probe';
import { runVerificationPass, type PassDependencies } from './verification-pass';

export interface VerificationServiceDependencies {
  readonly executions: ExecutionRepository;
  readonly versions: CodeVersionRepository;
  readonly verifications: VerificationRepository;
  readonly fixtures: SyntheticFixtureRepository;
  readonly uploads: UploadRepository;
  readonly profiles: UploadProfileRepository;
  readonly probe: RuntimeProbe;
  readonly pass: PassDependencies;
  readonly paths: AppPaths;
  readonly state: ExecutionStateWriter;
  readonly publish: (executionId: number, event: import('@automate/core').UnnumberedConversationEvent) => void;
  /** Registers a running pass for cancellation and the concurrency cap. */
  readonly track: (executionId: number, job: PhaseJob) => PhaseJob;
  readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  readonly timeoutMs?: number;
}

export interface VerifyOptions {
  /** Re-derive even for an unchanged runtime; rejected by the unique index when a verdict already exists. */
  readonly force?: boolean;
  /** Probe the runtime again rather than using the memo. */
  readonly fresh?: boolean;
  readonly signal?: AbortSignal;
}

const INCONCLUSIVE: readonly VerificationStatus[] = ['aborted', 'timed_out', 'errored'];
const RE_VERIFIABLE: readonly ExecutionStatus[] = ['verifying', 'awaiting_approval'];

/** Runs verification passes and turns their verdicts into execution state. */
export class VerificationService {
  constructor(private readonly deps: VerificationServiceDependencies) {}

  /**
   * Start a pass in the background, tracked for cancellation and the concurrency cap.
   * @returns The tracked job; its `settled` never rejects.
   * @throws Synchronously, before anything is tracked, when the execution cannot be verified (see `verify`).
   */
  start(executionId: number, options: Omit<VerifyOptions, 'signal'> = {}): PhaseJob {
    this.finalVersion(executionId);
    const controller = new AbortController();
    const settled = this.verify(executionId, { ...options, signal: controller.signal }).catch((cause: unknown) => this.onUnexpected(executionId, cause));
    return this.deps.track(executionId, { abort: () => controller.abort(), settled });
  }

  /**
   * Verify an execution's final version on the current runtime.
   * @returns The pass that applies: reused for an unchanged (version, runtime) pair, otherwise new.
   * @throws CodeVersionNotFinalError without a final version; ValidationError outside `verifying`/`awaiting_approval`; a typed VALIDATION_ERROR for `force` on an existing verdict.
   */
  async verify(executionId: number, options: VerifyOptions = {}): Promise<VerificationRunRow | undefined> {
    const signal = options.signal ?? new AbortController().signal;
    const version = this.finalVersion(executionId);
    const runtime = await this.probe(executionId, signal, options);
    if (!runtime) return undefined;
    const existing = this.deps.verifications.findByScope(version.id, runtime.fingerprint);
    if (existing && INCONCLUSIVE.includes(existing.status as VerificationStatus)) this.deps.verifications.discardInconclusive(existing.id);
    else if (existing && !options.force) {
      this.applyVerdict(executionId, this.deps.verifications.getWithChecks(existing.id)!);
      return existing;
    }
    const run = this.deps.verifications.open({ executionId, codeVersionId: version.id, contentDigest: version.contentDigest!, runtimeFingerprint: runtime.fingerprint, runtimeDetail: runtime.detail });
    this.deps.state.move(executionId, 'verifying');
    this.deps.logger.info({ executionId, codeVersionId: version.id, digest: shortDigest(version.contentDigest!), fingerprint: shortDigest(runtime.fingerprint) }, 'verification opened');
    return this.execute(executionId, version, run, signal);
  }

  /** The latest pass with its checks and findings, for the report route. */
  report(executionId: number) {
    if (!this.deps.executions.getById(executionId)) throw new ExecutionNotFoundError(executionId);
    const latest = this.deps.verifications.getLatest(executionId);
    return latest ? presentVerification(this.deps.verifications.getWithChecks(latest.id)!) : null;
  }

  private finalVersion(executionId: number): CodeVersionWithFiles {
    const execution = this.deps.executions.getById(executionId);
    if (!execution) throw new ExecutionNotFoundError(executionId);
    if (!RE_VERIFIABLE.includes(execution.status as ExecutionStatus)) throw new ValidationError(`Run ${executionId} is ${execution.status.replace('_', ' ')}; only a run being checked or waiting for approval can be checked again.`, undefined, ERROR_CODES.INVALID_STATE_TRANSITION);
    const final = this.deps.versions.findFinal(executionId);
    if (!final || final.contentDigest === null) throw new CodeVersionNotFinalError();
    return this.deps.versions.getByIdWithFiles(final.id)!;
  }

  /** Probe the runtime; a missing uv or Python fails a run already handed off, and is thrown to a person re-verifying. */
  private async probe(executionId: number, signal: AbortSignal, options: VerifyOptions): Promise<ProbedRuntime | undefined> {
    try {
      return await this.deps.probe.probe(signal, { fresh: options.fresh === true || options.force === true });
    } catch (cause) {
      const error = cause instanceof AutoMateError ? { code: cause.code, message: cause.message } : { code: ERROR_CODES.PYTHON_RUNTIME_UNAVAILABLE, message: 'The Python environment could not be inspected, so the code could not be checked. Make sure uv and Python 3.11 or newer are installed, then try again.' };
      this.deps.logger.warn({ executionId, code: error.code }, 'runtime probe failed before verification');
      if (this.deps.state.current(executionId) !== 'verifying') throw cause;
      this.deps.state.settle(executionId, signal.aborted ? 'aborted' : 'failed', signal.aborted ? undefined : error, !signal.aborted);
      return undefined;
    }
  }

  /** Run the checks under one wall clock, settle once, and turn the verdict into state. */
  private async execute(executionId: number, version: CodeVersionWithFiles, run: VerificationRunRow, external: AbortSignal): Promise<VerificationRunRow> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    external.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.deps.timeoutMs ?? VERIFICATION_TIMEOUT_MS);
    if (external.aborted) controller.abort();
    try {
      const result = await runVerificationPass(this.deps.pass, this.inputs(executionId, version), controller.signal);
      const status: VerificationStatus = result.interrupted ? (timedOut ? 'timed_out' : 'aborted') : 'passed';
      return this.settle(executionId, run, result.checks, status);
    } catch (cause) {
      this.deps.logger.error({ executionId, err: cause }, 'verification pass failed unexpectedly');
      return this.settle(executionId, run, [], 'errored');
    } finally {
      clearTimeout(timer);
      external.removeEventListener('abort', onAbort);
    }
  }

  private inputs(executionId: number, version: CodeVersionWithFiles) {
    const uploads = this.deps.uploads.listByTask(this.deps.executions.getById(executionId)!.taskId).map((upload) => ({ storedFilename: upload.storedFilename, tables: this.deps.profiles.listByUpload(upload.id) }));
    const verifyDir = resolveWithin(this.deps.paths.runsDir, String(executionId), 'verify');
    return { executionId, version, fixtures: this.deps.fixtures.listByExecution(executionId), uploads, verifyDir: path.normalize(verifyDir) };
  }

  /** Resolve blocking per check from the one gate policy, write everything at once, and announce it. */
  private settle(executionId: number, run: VerificationRunRow, checks: readonly NewCheck[], interruption: Exclude<VerificationStatus, 'running'>): VerificationRunRow {
    const findings = checks.flatMap((check) => check.findings.map((finding) => ({ ...finding, checkKey: check.checkKey })));
    const decision = decideGate(checks, findings);
    const resolved = checks.map((check) => ({ ...check, isBlocking: decision.reasons.includes(check.checkKey) }));
    const status: Exclude<VerificationStatus, 'running'> = interruption !== 'passed' ? interruption : decision.allowed ? 'passed' : 'failed';
    const durationMs = Math.max(0, Date.now() - run.startedAt.getTime());
    const views = resolved.map(({ checkKey, status: checkStatus, isBlocking, summary: text, detail, durationMs: ms }) => ({ checkKey, status: checkStatus, isBlocking, summary: text, detail: detail ?? null, durationMs: ms }));
    const summary = summarizeVerification({ status, blockingCount: decision.blockingCount, advisoryCount: decision.advisoryCount }, views, findings);
    const settled = this.deps.verifications.settle(run.id, { status, summary, durationMs, checks: resolved });
    this.announce(executionId, settled, decision.reasons.length);
    this.applyVerdict(executionId, settled);
    return settled;
  }

  private announce(executionId: number, run: VerificationRunWithChecks, blockingChecks: number): void {
    const runtime = describeRuntime(JSON.parse(run.runtimeDetail));
    this.deps.publish(executionId, { type: 'verification_finished', verificationRunId: run.id, codeVersionId: run.codeVersionId, status: run.status as VerificationStatus, blockingCount: run.blockingCount, advisoryCount: run.advisoryCount, summary: run.summary ?? '', runtimeDescription: runtime, at: new Date().toISOString() });
    const checks = Object.fromEntries(run.checks.map(({ checkKey, status }) => [checkKey, status]));
    const log = { executionId, verificationRunId: run.id, codeVersionId: run.codeVersionId, digest: shortDigest(run.contentDigest), fingerprint: shortDigest(run.runtimeFingerprint), status: run.status, checks, blockingCount: run.blockingCount, advisoryCount: run.advisoryCount, durationMs: run.durationMs };
    if (run.status === 'passed') this.deps.logger.info(log, 'verification settled');
    else this.deps.logger.warn({ ...log, blockingChecks }, 'verification did not allow the run');
  }

  /** `verifying → awaiting_approval` when allowed; otherwise settle with the verdict. Idempotent for a parked execution. */
  private applyVerdict(executionId: number, run: VerificationRunWithChecks): void {
    const current = this.deps.state.current(executionId);
    if (run.status === 'passed') { if (current === 'verifying') this.deps.state.move(executionId, 'awaiting_approval'); return; }
    if (current !== 'verifying' && current !== 'awaiting_approval') return;
    if (run.status === 'aborted') { this.deps.state.settle(executionId, 'aborted'); return; }
    this.deps.state.settle(executionId, 'failed', { code: ERROR_CODES.VERIFICATION_BLOCKED, message: run.summary ?? 'The code could not be checked, so it cannot run yet.' });
  }

  /** Last resort for a pass that threw outside `execute`: never leave the execution in `verifying`. */
  private onUnexpected(executionId: number, cause: unknown): void {
    const message = cause instanceof AutoMateError ? cause.message : 'The code could not be checked because of an unexpected problem. Try again.';
    if (!(cause instanceof AutoMateError)) this.deps.logger.error({ executionId, err: cause }, 'verification failed unexpectedly');
    if (this.deps.state.current(executionId) === 'verifying') this.deps.state.settle(executionId, 'failed', { code: cause instanceof AutoMateError ? cause.code : ERROR_CODES.INTERNAL_ERROR, message }, true);
  }
}
