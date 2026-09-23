import type { ExecutionSummary, Task } from '@automate/core';
import type { ExecutionRow } from '../db/repositories/execution-repository';
import type { TaskRow } from '../db/repositories/task-repository';

/** Project a task row onto its browser-safe API contract. */
export function presentTask(row: TaskRow): Task {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Project execution state without exposing the raw agent log path. */
export function presentExecution(row: ExecutionRow): ExecutionSummary {
  return {
    id: row.id,
    taskId: row.taskId,
    status: row.status as ExecutionSummary['status'],
    provider: row.provider,
    model: row.model,
    usage: {
      ...(row.usageTurns === null ? {} : { turns: row.usageTurns }),
      ...(row.usageInputTokens === null
        ? {}
        : { inputTokens: row.usageInputTokens }),
      ...(row.usageOutputTokens === null
        ? {}
        : { outputTokens: row.usageOutputTokens }),
      ...(row.usageCostUsd === null ? {} : { costUsd: row.usageCostUsd }),
    },
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    durationMs: row.durationMs,
    error:
      row.errorCode && row.errorMessage
        ? { code: row.errorCode, message: row.errorMessage }
        : null,
    createdAt: row.createdAt.toISOString(),
  };
}
