import { and, asc, eq, isNull, lt } from 'drizzle-orm';
import {
  RepositoryError,
  UploadAlreadyAttachedError,
  UploadNotFoundError,
  type FileFormat,
} from '@automate/core';
import type { DatabaseConnection } from '../client';
import { upload } from '../schema';

export type UploadRow = typeof upload.$inferSelect;

/** What intake knows once a file's bytes are safely on disk. */
export interface NewStagedUpload {
  readonly originalFilename: string;
  readonly storedFilename: string;
  /** Relative to the data root. */
  readonly filePath: string;
  readonly format: FileFormat;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
}

/**
 * Exclusive data-access path for uploaded input files (FEAT-104).
 *
 * Rows only: files are the upload file store's job. Deleting a row here does
 * not unlink its file; callers pair the two.
 */
export class UploadRepository {
  constructor(
    private readonly connection: DatabaseConnection,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Record a file that has landed in the staged area. @param input Intake facts. @returns The new row, unattached. */
  createStaged(input: NewStagedUpload): UploadRow {
    return this.write('saved', () =>
      this.connection.db
        .insert(upload)
        .values({ ...input, stagedAt: this.now(), createdAt: this.now() })
        .returning()
        .get(),
    );
  }

  /**
   * Record a received file whose stored name and path depend on its own id.
   *
   * @param facts Intake facts.
   * @param locate Derives the stored filename and relative path from the new id.
   * @returns The new row, already carrying its final staged location.
   */
  stage(
    facts: Omit<NewStagedUpload, 'storedFilename' | 'filePath'>,
    locate: (id: number) => { storedFilename: string; filePath: string },
  ): UploadRow {
    return this.write('saved', () =>
      this.connection.db.transaction((tx) => {
        const placeholder = { storedFilename: '', filePath: '' };
        const row = tx.insert(upload).values({ ...facts, ...placeholder, stagedAt: this.now(), createdAt: this.now() }).returning().get();
        return tx.update(upload).set(locate(row.id)).where(eq(upload.id, row.id)).returning().get()!;
      }),
    );
  }

  /** Read one upload. @param id Upload id. @returns The row, or undefined. */
  getById(id: number): UploadRow | undefined {
    return this.read(() => this.connection.db.select().from(upload).where(eq(upload.id, id)).get());
  }

  /** A task's uploads in the order they were created. @param taskId Task id. */
  listByTask(taskId: number): UploadRow[] {
    return this.read(() =>
      this.connection.db.select().from(upload).where(eq(upload.taskId, taskId)).orderBy(asc(upload.id)).all(),
    );
  }

  /** Unattached uploads staged before a cutoff; never an attached one. @param cutoff Oldest staging time to keep. */
  listStagedBefore(cutoff: Date): UploadRow[] {
    return this.read(() =>
      this.connection.db
        .select()
        .from(upload)
        .where(and(isNull(upload.taskId), lt(upload.stagedAt, cutoff)))
        .orderBy(asc(upload.id))
        .all(),
    );
  }

  /**
   * Claim a staged upload for a task.
   *
   * @param id Upload id.
   * @param taskId The claiming task.
   * @param filePath The file's new location, relative to the data root.
   * @returns The updated row.
   * @throws UploadNotFoundError when the row does not exist.
   * @throws UploadAlreadyAttachedError when another task already claimed it.
   */
  attachToTask(id: number, taskId: number, filePath: string): UploadRow {
    const updated = this.write('attached', () =>
      this.connection.db
        .update(upload)
        .set({ taskId, filePath, attachedAt: this.now() })
        .where(and(eq(upload.id, id), isNull(upload.taskId)))
        .returning()
        .get(),
    );
    if (updated) return updated;
    if (!this.getById(id)) throw new UploadNotFoundError(id);
    throw new UploadAlreadyAttachedError(id);
  }

  /** Mark profiling as started. @param id Upload id. */
  markProfiling(id: number): UploadRow {
    return this.update(id, { profileStatus: 'profiling', profileErrorCode: null, profileErrorMessage: null });
  }

  /** Mark profiling as finished. @param id Upload id. @param value Detected encoding (CSV) and elapsed time. */
  markProfiled(id: number, value: { encoding: string | null; durationMs: number }): UploadRow {
    return this.update(id, {
      profileStatus: 'profiled',
      encoding: value.encoding,
      profileDurationMs: Math.max(0, Math.round(value.durationMs)),
    });
  }

  /** Mark profiling as failed with a plain-English reason; the stored file is left in place. */
  markFailed(id: number, value: { code: string; message: string; durationMs?: number }): UploadRow {
    return this.update(id, {
      profileStatus: 'failed',
      profileErrorCode: value.code,
      profileErrorMessage: value.message,
      profileDurationMs: value.durationMs === undefined ? null : Math.max(0, Math.round(value.durationMs)),
    });
  }

  /** Delete one row; its profiles and columns cascade. @param id Upload id. @returns Whether a row was removed. */
  deleteById(id: number): boolean {
    return this.write('deleted', () => this.connection.db.delete(upload).where(eq(upload.id, id)).returning().all().length > 0);
  }

  private update(id: number, patch: Partial<typeof upload.$inferInsert>): UploadRow {
    const row = this.write('updated', () =>
      this.connection.db.update(upload).set(patch).where(eq(upload.id, id)).returning().get(),
    );
    if (!row) throw new UploadNotFoundError(id);
    return row;
  }

  private read<T>(action: () => T): T {
    try {
      return action();
    } catch (cause) {
      throw new RepositoryError('Uploaded file data could not be read.', cause);
    }
  }

  private write<T>(verb: string, action: () => T): T {
    try {
      return action();
    } catch (cause) {
      throw new RepositoryError(`The uploaded file could not be ${verb}.`, cause);
    }
  }
}
