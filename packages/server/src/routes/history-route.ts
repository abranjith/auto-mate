import { Value } from '@sinclair/typebox/value';
import { Router } from 'express';
import { ExecutionNotFoundError, HISTORY_PAGE_DEFAULT, TaskHistoryQuerySchema, RunTimelineQuerySchema, TaskNotFoundError, ValidationError, type TaskHistoryQuery, type RunTimelineQuery } from '@automate/core';
import type { Logger } from 'pino';
import type { HistoryRepository } from '../db/repositories/history-repository';
import type { TaskRepository } from '../db/repositories/task-repository';
import type { TaskDeletionService } from '../history/task-deletion-service';
import type { ServerConfig } from '../config/env';
import { originGuard } from '../middleware/origin-guard';

export interface HistoryRouteDependencies {
  history: HistoryRepository;
  tasks: TaskRepository;
  deletion: TaskDeletionService;
  config: ServerConfig;
  logger: Pick<Logger, 'debug'>;
}

function parseId(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new ValidationError('The id must be a positive integer.');
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new ValidationError('The id must be a safe positive integer.');
  return id;
}
function query<S extends typeof TaskHistoryQuerySchema | typeof RunTimelineQuerySchema>(schema: S, value: unknown): S extends typeof TaskHistoryQuerySchema ? TaskHistoryQuery : RunTimelineQuery {
  if (!Value.Check(schema, value)) throw new ValidationError('History query parameters are invalid. Limit must be between 1 and 50.');
  return value as S extends typeof TaskHistoryQuerySchema ? TaskHistoryQuery : RunTimelineQuery;
}

/** Four history routes: list, timeline, record, and whole-task deletion. */
export function historyRoute(deps: HistoryRouteDependencies): Router {
  const router = Router();
  router.get('/api/tasks', (request, response, next) => {
    try {
      const parsed = query(TaskHistoryQuerySchema, request.query);
      const group = parsed.status ?? 'all'; const q = parsed.q?.trim();
      const page = deps.history.listTasks({ limit: parsed.limit ? Number(parsed.limit) : HISTORY_PAGE_DEFAULT, ...(parsed.cursor ? { cursor: parseId(parsed.cursor) } : {}), group, ...(q ? { q } : {}) });
      deps.logger.debug({ count: page.items.length, hasMore: page.hasMore, group, hasQuery: Boolean(q) }, 'history page served');
      response.json(page);
    } catch (cause) { next(cause); }
  });
  router.get('/api/tasks/:taskId/runs', (request, response, next) => {
    try {
      const taskId = parseId(String(request.params.taskId));
      if (!deps.tasks.getById(taskId)) throw new TaskNotFoundError(taskId);
      const parsed = query(RunTimelineQuerySchema, request.query);
      response.json(deps.history.listRuns(taskId, { limit: parsed.limit ? Number(parsed.limit) : HISTORY_PAGE_DEFAULT, ...(parsed.cursor ? { cursor: parseId(parsed.cursor) } : {}) }));
    } catch (cause) { next(cause); }
  });
  router.get('/api/executions/:id/record', (request, response, next) => {
    try {
      const id = parseId(String(request.params.id));
      if (Object.keys(request.query).length) throw new ValidationError('This record does not accept query parameters.');
      const record = deps.history.getRunRecord(id);
      if (!record) throw new ExecutionNotFoundError(id);
      response.json(record);
    } catch (cause) { next(cause); }
  });
  router.delete('/api/tasks/:taskId', originGuard(deps.config), async (request, response, next) => {
    try { response.json(await deps.deletion.delete(parseId(String(request.params.taskId)))); }
    catch (cause) { next(cause); }
  });
  return router;
}
