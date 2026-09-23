import { Value } from '@sinclair/typebox/value';
import {
  CreateTaskRequestSchema,
  TaskNotFoundError,
  ValidationError,
  type CreateTaskRequest,
} from '@automate/core';
import { Router } from 'express';
import type { ServerConfig } from '../config/env';
import {
  presentExecution,
  presentTask,
  type TaskSessionRegistry,
} from '../conversation/index';
import type { ExecutionRepository } from '../db/repositories/execution-repository';
import type { TaskRepository } from '../db/repositories/task-repository';
import { originGuard } from '../middleware/origin-guard';

export interface TaskRouteDependencies {
  tasks: TaskRepository;
  executions: ExecutionRepository;
  registry: TaskSessionRegistry;
  config: ServerConfig;
}
function parseId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1)
    throw new ValidationError('The task id must be a positive integer.');
  return id;
}

/** Build task creation and detail endpoints. */
export function taskRoute(deps: TaskRouteDependencies): Router {
  const router = Router();
  router.post(
    '/api/tasks',
    originGuard(deps.config),
    (request, response, next) => {
      try {
        const body: unknown = request.body;
        if (!Value.Check(CreateTaskRequestSchema, body))
          throw new ValidationError(
            'Enter a task description between 1 and 8000 characters.',
          );
        const prompt = (body as CreateTaskRequest).prompt;
        deps.registry.assertCapacity();
        const created = deps.tasks.createWithExecution(prompt);
        deps.registry.start(created.execution, created.task);
        response
          .status(201)
          .json({
            task: presentTask(created.task),
            execution: presentExecution(
              deps.executions.getById(created.execution.id) ??
                created.execution,
            ),
          });
      } catch (cause) {
        next(cause);
      }
    },
  );
  router.get('/api/tasks/:taskId', (request, response, next) => {
    try {
      const id = parseId(String(request.params.taskId));
      const row = deps.tasks.getById(id);
      if (!row) throw new TaskNotFoundError(id);
      response.json({
        task: presentTask(row),
        executions: deps.executions.listByTask(id).map(presentExecution),
      });
    } catch (cause) {
      next(cause);
    }
  });
  return router;
}
