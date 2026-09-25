// ---------------------------------------------------------------------------
// Orphan sweep for uploads (FEAT-104 TASK-009).
//
// This is ORPHAN CLEANUP, not the retention policy. Retention (D12) is life
// of the task: an attached upload is never touched here, whatever its age.
// The sweep removes:
//   1. uploads still unattached after AUTOMATE_STAGED_UPLOAD_TTL_HOURS — rows
//      and files;
//   2. entries under `uploads/staged/` with no database row at all — the
//      residue of a crash between writing a file and inserting its row, which
//      nothing else would ever clean up;
//   3. `uploads/<taskId>/` directories whose task no longer exists — the file
//      half of "deleted with its task", since SQLite cascades do not touch the
//      filesystem.
// ---------------------------------------------------------------------------

import type { Logger } from 'pino';
import type { TaskRepository } from '../db/repositories/task-repository';
import type { UploadRepository } from '../db/repositories/upload-repository';
import type { UploadFileStore } from './upload-file-store';

/** How often the sweep repeats after the startup run. */
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** A partially received file younger than this may still be arriving. */
export const INCOMING_GRACE_MS = 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;

export interface SweeperDependencies {
  readonly uploads: UploadRepository;
  readonly tasks: Pick<TaskRepository, 'getById'>;
  readonly store: UploadFileStore;
  readonly ttlHours: number;
  readonly logger: Logger;
  readonly now?: () => Date;
  readonly intervalMs?: number;
}

/** What one sweep removed. */
export interface SweepResult {
  readonly expiredUploads: number;
  readonly orphanedStagedEntries: number;
  readonly orphanedTaskDirectories: number;
}

/** Periodically removes orphaned uploads. `start()` schedules it; `stop()` clears the timer. */
export class StagedUploadSweeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<SweepResult> | null = null;

  constructor(private readonly deps: SweeperDependencies) {}

  /** Run one sweep. Concurrent calls share the run in flight. @returns Counts of what was removed. */
  sweep(): Promise<SweepResult> {
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Schedule repeated sweeps. Idempotent. The timer does not keep the process alive. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sweep().catch((cause: unknown) => this.deps.logger.error({ err: cause }, 'upload sweep failed'));
    }, this.deps.intervalMs ?? SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** Clear the schedule, as part of shutdown. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async run(): Promise<SweepResult> {
    const now = (this.deps.now ?? (() => new Date()))();
    const result: SweepResult = {
      expiredUploads: await this.removeExpired(now),
      orphanedStagedEntries: await this.removeRowlessStaged(now),
      orphanedTaskDirectories: await this.removeTasklessDirectories(),
    };
    this.deps.logger.info(result, 'upload sweep complete');
    return result;
  }

  private async removeExpired(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - this.deps.ttlHours * MS_PER_HOUR);
    const expired = this.deps.uploads.listStagedBefore(cutoff);
    for (const row of expired) {
      this.deps.uploads.deleteById(row.id);
      await this.deps.store.removeFiles(row);
    }
    return expired.length;
  }

  private async removeRowlessStaged(now: Date): Promise<number> {
    let removed = 0;
    for (const entry of await this.deps.store.listStagedEntries()) {
      const rowless = entry.uploadId !== null && !this.deps.uploads.getById(entry.uploadId);
      const staleIncoming = entry.incoming && now.getTime() - entry.modifiedAt.getTime() > INCOMING_GRACE_MS;
      if (!rowless && !staleIncoming) continue;
      await this.deps.store.removeStagedEntry(entry.name);
      this.deps.logger.warn({ uploadId: entry.uploadId, incoming: entry.incoming }, 'removed staged upload residue with no database row');
      removed += 1;
    }
    return removed;
  }

  private async removeTasklessDirectories(): Promise<number> {
    let removed = 0;
    for (const taskId of await this.deps.store.listTaskDirectories()) {
      if (this.deps.tasks.getById(taskId)) continue;
      await this.deps.store.removeTaskDirectory(taskId);
      removed += 1;
    }
    return removed;
  }
}
