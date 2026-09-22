import { Router } from 'express';
import { Value } from '@sinclair/typebox/value';
import { HealthResponseSchema, type HealthResponse } from '@automate/core';
import type { Logger } from 'pino';

export interface HealthDependencies { getSchemaVersion(): string; dataRoot: string; version: string; logger: Logger }

/** Build the health endpoint. @param deps Metadata probe, version, root, and logger. @returns A router reporting healthy or degraded database state. */
export function healthRoute(deps: HealthDependencies): Router {
  const router = Router();
  router.get('/api/health', (_request, response, next) => {
    try {
      let connected = true;
      let schemaVersion = 'unknown';
      try { schemaVersion = deps.getSchemaVersion(); }
      catch (cause) {
        connected = false;
        deps.logger.warn({ err: cause, correlationId: response.locals.correlationId }, 'health database probe failed');
      }
      const payload: HealthResponse = {
        status: connected ? 'ok' : 'degraded', version: deps.version,
        uptimeSeconds: process.uptime(), database: { connected, schemaVersion }, dataRoot: deps.dataRoot,
      };
      if (!Value.Check(HealthResponseSchema, payload)) throw new Error('Invalid health payload');
      response.json(payload);
    } catch (cause) { next(cause); }
  });
  return router;
}
