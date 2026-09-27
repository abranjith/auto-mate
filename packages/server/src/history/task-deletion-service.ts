import { TaskHasOpenRunError, TaskNotFoundError, type DeleteTaskResponse, type ExecutionStatus } from '@automate/core';
import type { Logger } from 'pino';
import type { AppPaths } from '../config/app-paths';
import type { ExecutionRepository } from '../db/repositories/execution-repository';
import type { TaskRepository } from '../db/repositories/task-repository';
import type { TaskSessionRegistry } from '../conversation/task-session-registry';
import { treesForTask } from './task-owned-trees';
import { removeTree } from './safe-remove';

/** Owns the rows-first, files-second whole-task deletion operation. */
export class TaskDeletionService {
  constructor(private readonly deps: { paths: AppPaths; tasks: TaskRepository; executions: ExecutionRepository; registry: TaskSessionRegistry; logger: Pick<Logger, 'info' | 'warn'> }) {}

  /** Delete one task and report directories the next startup must retry. */
  async delete(taskId: number): Promise<DeleteTaskResponse> {
    if (!this.deps.tasks.getById(taskId)) throw new TaskNotFoundError(taskId);
    for (const run of this.deps.executions.listByTask(taskId)) {
      if (this.deps.registry.isLive(run.id)) {
        this.deps.logger.warn({ taskId, runId: run.id }, 'task delete refused for a live run');
        throw new TaskHasOpenRunError(run.id, run.status as ExecutionStatus);
      }
    }
    const { executionIds, counts } = this.deps.tasks.deleteOwnedRows(taskId);
    const results = await Promise.all(treesForTask(this.deps.paths, taskId, executionIds).map(async (tree) => {
      const result = await removeTree(tree.base, tree.name);
      if (!result.removed) this.deps.logger.warn({ kind: tree.kind, code: result.code }, 'task files pending removal');
      return result;
    }));
    const filesPendingRemoval = results.filter((result) => !result.removed).length;
    this.deps.logger.info({ taskId, ...counts, treesRemoved: results.length - filesPendingRemoval, treesPending: filesPendingRemoval }, 'task deleted');
    return { taskId, removed: counts, filesPendingRemoval };
  }
}
