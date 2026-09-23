import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { ExecutionNotFoundError, ValidationError } from '@automate/core';
import { Router } from 'express';
import type { ServerConfig } from '../config/env';
import {
  presentExecution,
  type TaskSessionRegistry,
} from '../conversation/index';
import type { ConversationEventRepository } from '../db/repositories/conversation-event-repository';
import type { ExecutionRepository } from '../db/repositories/execution-repository';
import { originGuard } from '../middleware/origin-guard';

export interface ExecutionRouteDependencies {
  executions: ExecutionRepository;
  events: ConversationEventRepository;
  registry: TaskSessionRegistry;
  config: ServerConfig;
}
const QuerySchema = Type.Object(
  {
    afterSeq: Type.Optional(Type.String({ pattern: '^\\d+$' })),
    limit: Type.Optional(Type.String({ pattern: '^\\d+$' })),
  },
  { additionalProperties: false },
);
function idOf(raw: unknown): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1)
    throw new ValidationError('The execution id must be a positive integer.');
  return id;
}
function required(deps: ExecutionRouteDependencies, id: number) {
  const row = deps.executions.getById(id);
  if (!row) throw new ExecutionNotFoundError(id);
  return row;
}

/** Build execution summary, replay, and abort endpoints. */
export function executionRoute(deps: ExecutionRouteDependencies): Router {
  const router = Router();
  router.get('/api/executions/:id', (request, response, next) => {
    try {
      const id = idOf(request.params.id);
      response.json(presentExecution(required(deps, id)));
    } catch (cause) {
      next(cause);
    }
  });
  router.get('/api/executions/:id/events', (request, response, next) => {
    try {
      const id = idOf(request.params.id);
      required(deps, id);
      const query: unknown = request.query;
      if (!Value.Check(QuerySchema, query))
        throw new ValidationError(
          'The event cursor and limit must be non-negative integers.',
        );
      const afterSeq = Number((query as { afterSeq?: string }).afterSeq ?? 0);
      const requested = Number((query as { limit?: string }).limit ?? 200);
      const limit = Math.min(500, Math.max(1, requested));
      response.json(deps.events.listAfter(id, afterSeq, limit));
    } catch (cause) {
      next(cause);
    }
  });
  router.post(
    '/api/executions/:id/abort',
    originGuard(deps.config),
    (request, response, next) => {
      void (async () => {
        try {
          const id = idOf(request.params.id);
          required(deps, id);
          response.json(presentExecution(await deps.registry.abort(id)));
        } catch (cause) {
          next(cause);
        }
      })();
    },
  );
  return router;
}
