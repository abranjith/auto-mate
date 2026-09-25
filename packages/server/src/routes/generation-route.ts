import { Value } from '@sinclair/typebox/value';
import { MAX_GUIDANCE_CHARS, RetryRequestSchema, ValidationError, type RetryRequest } from '@automate/core';
import { Router } from 'express';
import type { ServerConfig } from '../config/env';
import { presentExecution, presentTask } from '../conversation/presenters';
import type { GenerationService } from '../generation/index';
import { originGuard } from '../middleware/origin-guard';

export interface GenerationRouteDependencies {
  readonly generation: GenerationService;
  readonly config: ServerConfig;
}

function idOf(raw: unknown, what: string): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1 || String(raw) !== String(id)) throw new ValidationError(`The ${what} id must be a positive integer.`);
  return id;
}

/** Parse the retry body; blank guidance is no guidance. */
function parseRetry(body: unknown): string | null {
  if (!Value.Check(RetryRequestSchema, body ?? {})) throw new ValidationError(`Guidance must be text of at most ${MAX_GUIDANCE_CHARS.toLocaleString('en-US')} characters.`);
  const guidance = (body as RetryRequest | undefined)?.guidance?.trim();
  return guidance ? guidance : null;
}

/** Code versions, attempts, fixtures, and the guidance retry (FEAT-106). */
export function generationRoute(deps: GenerationRouteDependencies): Router {
  const router = Router();
  router.get('/api/executions/:id/code-versions', (request, response, next) => {
    try { response.json({ codeVersions: deps.generation.listCodeVersions(idOf(request.params.id, 'execution')) }); } catch (cause) { next(cause); }
  });
  router.get('/api/code-versions/:id', (request, response, next) => {
    try { response.json(deps.generation.getCodeVersion(idOf(request.params.id, 'code version'))); } catch (cause) { next(cause); }
  });
  router.get('/api/executions/:id/attempts', (request, response, next) => {
    try { response.json({ attempts: deps.generation.listAttempts(idOf(request.params.id, 'execution')), limits: deps.generation.limits() }); } catch (cause) { next(cause); }
  });
  router.get('/api/executions/:id/fixtures', (request, response, next) => {
    try { response.json({ fixtures: deps.generation.listFixtures(idOf(request.params.id, 'execution')) }); } catch (cause) { next(cause); }
  });
  router.post('/api/executions/:id/retry', originGuard(deps.config), (request, response, next) => {
    try {
      const id = idOf(request.params.id, 'execution');
      const created = deps.generation.retry(id, parseRetry(request.body));
      response.status(201).json({ task: presentTask(created.task), execution: presentExecution(created.execution) });
    } catch (cause) { next(cause); }
  });
  return router;
}
