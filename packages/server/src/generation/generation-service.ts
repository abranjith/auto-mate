// The generation read model and the guidance retry (FEAT-106 TASK-013).
//
// Code and filtered diagnostics are served here, on demand, rather than in
// transcript events. No response carries an absolute path: versions name
// files by their relative path, fixtures by the stored filename.

import {
  CodeVersionNotFoundError,
  ExecutionNotFoundError,
  ExecutionNotRetryableError,
  FIXTURE_PREVIEW_ROWS,
  isTerminal,
  type CodeVersionDetail,
  type CodeVersionSummary,
  type ExecutionStatus,
  type FileFormat,
  type GenerationAttempt,
  type SyntheticFixture,
} from '@automate/core';
import type { Logger } from 'pino';
import type { TaskSessionRegistry } from '../conversation/task-session-registry';
import type { CodeVersionRepository } from '../db/repositories/code-version-repository';
import type { DisclosureTransmissionRepository } from '../db/repositories/disclosure-transmission-repository';
import type { ExecutionRepository, ExecutionRow } from '../db/repositories/execution-repository';
import type { GenerationAttemptRepository } from '../db/repositories/generation-attempt-repository';
import type { SyntheticFixtureRepository } from '../db/repositories/synthetic-fixture-repository';
import type { TaskRepository, TaskRow } from '../db/repositories/task-repository';
import type { UploadRepository } from '../db/repositories/upload-repository';
import type { DisclosureService } from '../disclosure/disclosure-service';
import type { PreflightService } from '../disclosure/preflight-service';
import type { FixtureService } from './fixture-service';
import { presentAttempt, presentCodeVersionDetail, presentCodeVersionSummary } from './presenters';

export interface GenerationServiceDependencies {
  readonly tasks: TaskRepository;
  readonly executions: ExecutionRepository;
  readonly versions: CodeVersionRepository;
  readonly attempts: GenerationAttemptRepository;
  readonly fixtures: SyntheticFixtureRepository;
  readonly fixtureService: FixtureService;
  readonly transmissions: DisclosureTransmissionRepository;
  readonly uploads: UploadRepository;
  readonly disclosure: DisclosureService;
  readonly preflight: PreflightService;
  readonly registry: Pick<TaskSessionRegistry, 'assertCapacity' | 'start'>;
  readonly logger: Pick<Logger, 'info'>;
  /** The attempt and time limits runs are held to, reported with the attempts. */
  readonly limits: { readonly maxAttempts: number; readonly timeoutMs: number };
}

/** Serves an execution's code, attempts, and fixtures, and starts guidance retries. */
export class GenerationService {
  constructor(private readonly deps: GenerationServiceDependencies) {}

  /** Every version of a run, newest attempt first, without file content. */
  listCodeVersions(executionId: number): CodeVersionSummary[] {
    this.requireExecution(executionId);
    return this.deps.versions.listByExecution(executionId).map((version) => presentCodeVersionSummary(version, version.files));
  }

  /** One version with every file's content. @throws CodeVersionNotFoundError. */
  getCodeVersion(id: number): CodeVersionDetail {
    const version = this.deps.versions.getByIdWithFiles(id);
    if (!version) throw new CodeVersionNotFoundError(id);
    return presentCodeVersionDetail(version, version.files);
  }

  /** Every attempt in order, each joined to the filtered text that was sent for it, if any. */
  listAttempts(executionId: number): GenerationAttempt[] {
    this.requireExecution(executionId);
    const sent = new Map(this.deps.transmissions.listByExecution(executionId).filter(({ kind }) => kind === 'diagnostics').map((row) => [row.payloadDigest, row.payloadSnapshot]));
    return this.deps.attempts.listByExecution(executionId).map((row) => presentAttempt(row, row.diagnosticDigest === null ? null : sent.get(row.diagnosticDigest) ?? null));
  }

  /** The attempt and time limits every run is held to. */
  limits(): { maxAttempts: number; timeoutMs: number } {
    return { maxAttempts: this.deps.limits.maxAttempts, timeoutMs: this.deps.limits.timeoutMs };
  }

  /** The synthetic stand-ins a run tested against, each with its first rows. */
  listFixtures(executionId: number): SyntheticFixture[] {
    this.requireExecution(executionId);
    return this.deps.fixtures.listByExecution(executionId).map((row) => ({
      id: row.id,
      executionId: row.executionId,
      uploadId: row.uploadId,
      fileName: row.filePath.split('/').pop() ?? '',
      format: row.format as FileFormat,
      sheetCount: row.sheetCount,
      rowCount: row.rowCount,
      sampleRowCount: row.sampleRowCount,
      byteSize: row.byteSize,
      sha256: row.sha256,
      seed: row.seed,
      createdAt: row.createdAt.toISOString(),
      preview: this.deps.fixtureService.preview(row.uploadId, row.seed, FIXTURE_PREVIEW_ROWS),
    }));
  }

  /**
   * Start a new run of a finished run's task, seeded with the person's guidance.
   *
   * The source run is never changed. The existing consent is re-verified, so a model changed since
   * the failed run reopens FEAT-105's gate instead of silently reusing a stale approval. Prior
   * pre-flight answers are seeded after the new run's own transaction commits.
   *
   * @param trigger `rerun` for a person's "try again" (FEAT-106); `feedback` for a rejected result (FEAT-107), whose words are the guidance.
   * @throws ExecutionNotRetryableError while the source is still active; FEAT-105's consent errors when approval is stale.
   */
  retry(executionId: number, guidance: string | null, trigger: 'rerun' | 'feedback' = 'rerun'): { task: TaskRow; execution: ExecutionRow } {
    const source = this.requireExecution(executionId);
    if (!isTerminal(source.status as ExecutionStatus)) throw new ExecutionNotRetryableError(executionId, source.status);
    const task = this.deps.tasks.getById(source.taskId)!;
    const uploadIds = this.deps.uploads.listByTask(task.id).map(({ id }) => id);
    if (uploadIds.length > 0) this.deps.disclosure.verifyForTransmission(task.id, 'context');
    const answers = uploadIds.length > 0 ? this.deps.preflight.resolveDecisions(uploadIds, [], task.id) : [];
    this.deps.registry.assertCapacity();
    const execution = trigger === 'feedback' && guidance !== null ? this.deps.executions.createFeedbackRetry(executionId, guidance) : this.deps.executions.createRetry(executionId, guidance);
    try { this.deps.preflight.persist(execution.id, answers); }
    catch (cause) {
      this.deps.executions.markSettled(execution.id, { status: 'failed', errorCode: 'REPOSITORY_ERROR', errorMessage: 'Your earlier answers could not be carried over to the retry. Try again.' });
      throw cause;
    }
    this.deps.logger.info({ sourceExecutionId: executionId, executionId: execution.id, trigger }, 'retry created');
    this.deps.registry.start(execution, task);
    return { task, execution: this.deps.executions.getById(execution.id) ?? execution };
  }

  private requireExecution(executionId: number): ExecutionRow {
    const row = this.deps.executions.getById(executionId);
    if (!row) throw new ExecutionNotFoundError(executionId);
    return row;
  }
}
