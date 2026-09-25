// ---------------------------------------------------------------------------
// Upload lifecycle (FEAT-104 TASK-008/009): receive → stage → profile →
// present; attach inside task creation; delete. Routes stay thin and every
// database write goes through a repository.
//
// Retention (D12): an attached upload lives exactly as long as its task. It is
// not deleted on its own, and nothing purges it by age. An unattached upload
// is swept after the staged TTL — orphan cleanup, not retention.
// ---------------------------------------------------------------------------

import {
  ERROR_CODES,
  UploadAlreadyAttachedError,
  UploadLimitReachedError,
  UploadNotFoundError,
  ValidationError,
  buildDisclosurePayload,
  type FileFormat,
  type ProfileStatus,
  type Upload,
  type UploadResponse,
} from '@automate/core';
import type { Logger } from 'pino';
import type { IngestionConfig } from '../config/env';
import type { UploadProfileRepository } from '../db/repositories/upload-profile-repository';
import type { UploadRepository, UploadRow } from '../db/repositories/upload-repository';
import type { ProfileService } from './profile-service';
import type { UploadFileStore } from './upload-file-store';
import { receiveUpload, type ReceivedUpload, type UploadRequest } from './upload-intake';

export interface UploadServiceDependencies {
  readonly uploads: UploadRepository;
  readonly profiles: UploadProfileRepository;
  readonly store: UploadFileStore;
  readonly profiler: ProfileService;
  readonly limits: IngestionConfig;
  readonly logger: Logger;
}

/** Render one upload row in its API shape. The only path is `filePath`, relative to the data root. */
export function presentUpload(row: UploadRow): Upload {
  return {
    id: row.id,
    taskId: row.taskId,
    originalFilename: row.originalFilename,
    storedFilename: row.storedFilename,
    filePath: row.filePath,
    format: row.format as FileFormat,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    sha256: row.sha256,
    encoding: row.encoding,
    profileStatus: row.profileStatus as ProfileStatus,
    profileError: row.profileErrorCode === null ? null : { code: row.profileErrorCode, message: row.profileErrorMessage ?? '' },
    profileDurationMs: row.profileDurationMs,
    stagedAt: row.stagedAt.toISOString(),
    attachedAt: row.attachedAt === null ? null : row.attachedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Orchestrates uploads end to end. */
export class UploadService {
  constructor(private readonly deps: UploadServiceDependencies) {}

  /**
   * Receive, stage, and profile one uploaded file.
   *
   * @param request The multipart request.
   * @returns The upload with its profiles and disclosure payload.
   * @throws Intake errors (nothing is kept) or profiling errors (the row is marked failed and the file kept).
   */
  async receive(request: UploadRequest): Promise<UploadResponse> {
    const received = await receiveUpload(request, { store: this.deps.store, maxUploadBytes: this.deps.limits.maxUploadBytes });
    const row = await this.stage(received);
    this.deps.logger.info({ uploadId: row.id, byteSize: row.byteSize, format: row.format }, 'upload received');
    await this.deps.profiler.profile(row.id);
    return this.describe(row.id);
  }

  private async stage(received: ReceivedUpload): Promise<UploadRow> {
    const { store, uploads } = this.deps;
    const { incomingPath, ...facts } = received;
    let row: UploadRow;
    try {
      row = uploads.stage(facts, (id) => {
        const storedFilename = store.storedNameFor(id, facts.originalFilename);
        return { storedFilename, filePath: store.relative(store.stagedPathFor(id, storedFilename.slice(`${id}-`.length))) };
      });
    } catch (cause) {
      await store.discardIncoming(incomingPath);
      throw cause;
    }
    try {
      await store.placeStaged(incomingPath, row.id, row.storedFilename);
      return row;
    } catch (cause) {
      uploads.deleteById(row.id);
      await store.discardIncoming(incomingPath);
      throw cause;
    }
  }

  /** One upload with its profiles and, once profiled, its disclosure payload. @throws UploadNotFoundError. */
  describe(id: number): UploadResponse {
    const row = this.deps.uploads.getById(id);
    if (!row) throw new UploadNotFoundError(id);
    const source = this.deps.profiles.getDisclosureSource(id);
    const profiles = source?.profiles ?? [];
    const disclosure = row.profileStatus === 'profiled' && source ? buildDisclosurePayload(source.upload, profiles) : null;
    return { upload: presentUpload(row), profiles, disclosure };
  }

  /** A task's uploads in the order they were created. */
  listForTask(taskId: number): UploadResponse[] {
    return this.deps.uploads.listByTask(taskId).map((row) => this.describe(row.id));
  }

  /**
   * Delete a staged upload and its files. An attached upload is deleted with its task, never on its own (D12).
   * @throws UploadNotFoundError, UploadAlreadyAttachedError.
   */
  async remove(id: number): Promise<void> {
    const row = this.deps.uploads.getById(id);
    if (!row) throw new UploadNotFoundError(id);
    if (row.taskId !== null) throw new UploadAlreadyAttachedError(id);
    this.deps.uploads.deleteById(id);
    await this.deps.store.removeFiles(row);
  }

  /**
   * Claim uploads for a new task. Call inside the transaction that creates the task: any failure throws and rolls the whole task back.
   *
   * @param taskId The task being created.
   * @param ids Upload ids from the request.
   * @returns The claimed rows, as they were while staged, for `moveAttached` after commit.
   */
  attachWithinTransaction(taskId: number, ids: readonly number[]): UploadRow[] {
    const { uploads, store, limits } = this.deps;
    if (ids.length > limits.maxFilesPerTask) throw new UploadLimitReachedError(ids.length, limits.maxFilesPerTask);
    return ids.map((id) => {
      const row = uploads.getById(id);
      if (!row) throw new UploadNotFoundError(id);
      if (row.taskId !== null) throw new UploadAlreadyAttachedError(id);
      if (row.profileStatus !== 'profiled') {
        throw new ValidationError(
          row.profileStatus === 'failed'
            ? `File ${id} could not be read, so it cannot be attached. Remove it and attach a corrected file.`
            : `File ${id} is still being analyzed. Wait for it to finish, then start the task.`,
        );
      }
      const target = store.taskPathFor(taskId, id, row.storedFilename.slice(`${id}-`.length));
      uploads.attachToTask(id, taskId, store.relative(target));
      return row;
    });
  }

  /**
   * Move claimed files into the task's directory, after the transaction has committed.
   * A failed move marks that upload failed and is logged; it never orphans the task.
   */
  async moveAttached(taskId: number, staged: readonly UploadRow[]): Promise<void> {
    for (const row of staged) {
      try {
        await this.deps.store.attach(row, taskId);
      } catch (cause) {
        this.deps.uploads.markFailed(row.id, { code: ERROR_CODES.INTERNAL_ERROR, message: "The file could not be moved into the task's folder." });
        this.deps.logger.warn({ err: cause, uploadId: row.id, taskId }, 'attached upload could not be moved');
      }
    }
  }
}
