import path from 'node:path';
import type { AppPaths } from '../config/app-paths';

/** Every directory owned by a task. Adding a new per-task tree requires adding it here. */
export const TASK_OWNED_TREES = [
  { kind: 'uploads', keyedBy: 'task', root: (paths: AppPaths) => paths.uploadsDir },
  { kind: 'artifacts', keyedBy: 'task', root: (paths: AppPaths) => paths.artifactsDir },
  { kind: 'runs', keyedBy: 'execution', root: (paths: AppPaths) => paths.runsDir },
  { kind: 'scripts', keyedBy: 'execution', root: (paths: AppPaths) => paths.scriptsDir },
  { kind: 'agent-sessions', keyedBy: 'execution', root: (paths: AppPaths) => paths.agentSessionsDir },
] as const;

/** Return the contained directory names that belong to a task and its runs. */
export function treesForTask(paths: AppPaths, taskId: number, executionIds: readonly number[]) {
  return TASK_OWNED_TREES.flatMap((tree) => (tree.keyedBy === 'task' ? [taskId] : executionIds).map((id) => ({ kind: tree.kind, base: tree.root(paths), name: String(id), fullPath: path.join(tree.root(paths), String(id)) })));
}
