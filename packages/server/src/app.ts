import express, { type Express } from 'express';
import { AutoMateError, ERROR_CODES } from '@automate/core';
import type { Logger } from 'pino';
import { correlationId } from './middleware/correlation-id';
import { errorHandler } from './middleware/error-handler';
import { healthRoute } from './routes/health-route';
import { agentRoute, type AgentRouteDependencies } from './routes/agent-route';
import { AgentConfigStore } from './agent/index';
import type { AppPaths } from './config/app-paths';

export interface AppDependencies {
  logger: Logger;
  dataRoot: string;
  version: string;
  getSchemaVersion(): string;
  /** Resolved application paths; the agent routes read every pinned Pi location from these. */
  paths: AppPaths;
  /** Agent seams the server composes for itself in production and tests inject. */
  agent?: Pick<AgentRouteDependencies, 'probe' | 'runSmoke' | 'configStore'>;
  configureRoutes?: (app: Express) => void;
}

/** Create the HTTP application. @param deps Logger, metadata probe, application paths, and public settings. @returns An Express instance without a network listener. */
export function createApp(deps: AppDependencies): Express {
  const app = express();
  app.use(correlationId(deps.logger));
  app.use(express.json({ limit: '1mb' }));
  app.use(healthRoute(deps));
  app.use(agentRoute({
    paths: deps.paths,
    configStore: deps.agent?.configStore ?? new AgentConfigStore({ paths: deps.paths, logger: deps.logger }),
    logger: deps.logger,
    ...(deps.agent?.probe !== undefined ? { probe: deps.agent.probe } : {}),
    ...(deps.agent?.runSmoke !== undefined ? { runSmoke: deps.agent.runSmoke } : {}),
  }));
  deps.configureRoutes?.(app);
  app.use((_request, _response, next) => next(new AutoMateError(ERROR_CODES.NOT_FOUND, 'The requested page was not found.')));
  app.use(errorHandler(deps.logger));
  return app;
}
