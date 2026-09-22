import express, { type Express } from 'express';
import { AutoMateError, ERROR_CODES } from '@automate/core';
import type { Logger } from 'pino';
import { correlationId } from './middleware/correlation-id';
import { errorHandler } from './middleware/error-handler';
import { healthRoute } from './routes/health-route';

export interface AppDependencies { logger: Logger; dataRoot: string; version: string; getSchemaVersion(): string; configureRoutes?: (app: Express) => void }

/** Create the HTTP application. @param deps Logger, metadata probe, and public settings. @returns An Express instance without a network listener. */
export function createApp(deps: AppDependencies): Express {
  const app = express();
  app.use(correlationId(deps.logger));
  app.use(express.json({ limit: '1mb' }));
  app.use(healthRoute(deps));
  deps.configureRoutes?.(app);
  app.use((_request, _response, next) => next(new AutoMateError(ERROR_CODES.NOT_FOUND, 'The requested page was not found.')));
  app.use(errorHandler(deps.logger));
  return app;
}
