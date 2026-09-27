// ---------------------------------------------------------------------------
// Artifact retention and the orphan sweep (FEAT-109 TASK-012, D12).
//
// RETENTION is the same sentence FEAT-104 wrote for inputs: outputs live for
// the life of the task, are deleted with it, and are never purged by age.
// There is no age-based purge here, no per-artifact delete, and no `saved`
// flag — the standalone library a per-artifact delete would belong to is
// deferred (D08).
//
// SQLite cascades remove `artifact` rows with their task, never files. The
// file half of "deleted with its task" is FEAT-110's `TaskDeletionService`,
// which removes `artifacts/<taskId>/` after the row transaction commits.
// `deleteTaskArtifacts` empties one such directory for the orphan sweep below.
//
// `sweepOrphanArtifactDirectories` removes `artifacts/<taskId>/` directories
// whose task no longer exists — the residue of a crash between a delete's row
// and its files, which nothing else would ever clean up. It runs at startup,
// after migrations and before the listener binds, beside FEAT-104's sweep. A
// live task's directory is never touched, whatever its age, and a directory
// whose name is not a task id is left alone rather than guessed at.
// ---------------------------------------------------------------------------

import { readdir, rm, rmdir } from 'node:fs/promises';
import type { Logger } from 'pino';
import { resolveWithin, type AppPaths } from '../config/app-paths';

export interface ArtifactSweeperDependencies {
  readonly paths: AppPaths;
  /** Whether a task row exists. */
  readonly taskExists: (taskId: number) => boolean;
  readonly logger: Pick<Logger, 'info' | 'warn'>;
}

/** Removes artifact files for deleted tasks. */
export class ArtifactSweeper {
  constructor(private readonly deps: ArtifactSweeperDependencies) {}

  /**
   * Delete every file under `artifacts/<taskId>/`, then the directory.
   * A file already gone behind the application is not an error.
   * @param taskId The deleted task.
   * @returns How many files were removed.
   */
  async deleteTaskArtifacts(taskId: number): Promise<number> {
    const directory = this.deps.paths.taskArtifactsDir(taskId);
    const names = await readdir(directory).catch(() => [] as string[]);
    for (const name of names) await rm(resolveWithin(directory, name), { force: true, recursive: true });
    await rmdir(directory).catch((cause: NodeJS.ErrnoException) => { if (cause.code !== 'ENOENT') throw cause; });
    this.deps.logger.info({ taskId, fileCount: names.length }, 'task artifacts deleted');
    return names.length;
  }

  /**
   * Remove artifact directories whose task no longer exists. Idempotent.
   * @returns How many directories were removed.
   */
  async sweepOrphanArtifactDirectories(): Promise<number> {
    const entries = await readdir(this.deps.paths.artifactsDir, { withFileTypes: true }).catch(() => []);
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[1-9]\d{0,14}$/.test(entry.name)) continue;
      const taskId = Number(entry.name);
      if (this.deps.taskExists(taskId)) continue;
      await this.deleteTaskArtifacts(taskId);
      removed += 1;
    }
    this.deps.logger.info({ removedDirectories: removed }, 'artifact orphan sweep complete');
    return removed;
  }
}
