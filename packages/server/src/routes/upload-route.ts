import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { TaskNotFoundError, ValidationError, type DeleteUploadResponse } from '@automate/core';
import { Router } from 'express';
import type { ServerConfig } from '../config/env';
import type { TaskRepository } from '../db/repositories/task-repository';
import type { UploadService } from '../ingestion/index';
import { originGuard } from '../middleware/origin-guard';

export interface UploadRouteDependencies {
  uploads: UploadService;
  tasks: TaskRepository;
  config: ServerConfig;
}

const IdParamsSchema = Type.Object({ id: Type.String({ pattern: '^[1-9][0-9]{0,14}$' }) });
const TaskParamsSchema = Type.Object({ taskId: Type.String({ pattern: '^[1-9][0-9]{0,14}$' }) });
const EmptyQuerySchema = Type.Object({}, { additionalProperties: false });

function uploadId(params: unknown): number {
  if (!Value.Check(IdParamsSchema, params)) throw new ValidationError('The file id must be a positive integer.');
  return Number(params.id);
}

function taskId(params: unknown): number {
  if (!Value.Check(TaskParamsSchema, params)) throw new ValidationError('The task id must be a positive integer.');
  return Number(params.taskId);
}

function noQuery(query: unknown): void {
  if (!Value.Check(EmptyQuerySchema, query)) throw new ValidationError('This request does not accept query parameters.');
}

/**
 * Upload endpoints (FEAT-104).
 *
 * `GET /api/tasks/:taskId/uploads` is deliberately NOT paginated, an exception
 * to the pagination rule: `AUTOMATE_MAX_FILES_PER_TASK` caps the collection at
 * five, so a page would only ever be the whole list.
 */
export function uploadRoute(deps: UploadRouteDependencies): Router {
  const router = Router();
  const guard = originGuard(deps.config);

  router.post('/api/uploads', guard, async (request, response, next) => {
    try {
      noQuery(request.query);
      response.status(201).json(await deps.uploads.receive(request));
    } catch (cause) {
      next(cause);
    }
  });

  router.get('/api/uploads/:id', (request, response, next) => {
    try {
      noQuery(request.query);
      response.json(deps.uploads.describe(uploadId(request.params)));
    } catch (cause) {
      next(cause);
    }
  });

  router.delete('/api/uploads/:id', guard, async (request, response, next) => {
    try {
      noQuery(request.query);
      const id = uploadId(request.params);
      await deps.uploads.remove(id);
      const body: DeleteUploadResponse = { id, deleted: true };
      response.json(body);
    } catch (cause) {
      next(cause);
    }
  });

  router.get('/api/tasks/:taskId/uploads', (request, response, next) => {
    try {
      noQuery(request.query);
      const id = taskId(request.params);
      if (!deps.tasks.getById(id)) throw new TaskNotFoundError(id);
      response.json({ uploads: deps.uploads.listForTask(id) });
    } catch (cause) {
      next(cause);
    }
  });

  return router;
}
