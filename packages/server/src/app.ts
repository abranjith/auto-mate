import express, { type Express } from 'express';
import { AutoMateError, ERROR_CODES } from '@automate/core';
import type { Logger } from 'pino';
import { correlationId } from './middleware/correlation-id';
import { errorHandler } from './middleware/error-handler';
import { healthRoute } from './routes/health-route';
import { agentRoute, type AgentRouteDependencies } from './routes/agent-route';
import { AgentConfigStore } from './agent/index';
import type { AppPaths } from './config/app-paths';
import type { ServerConfig } from './config/env';
import { taskRoute, type TaskRouteDependencies } from './routes/task-route';
import {
  executionRoute,
  type ExecutionRouteDependencies,
} from './routes/execution-route';
import { originGuard } from './middleware/origin-guard';
import { uploadRoute } from './routes/upload-route';
import type { UploadService } from './ingestion/index';
import { disclosureRoute } from './routes/disclosure-route';
import { clarificationRoute } from './routes/clarification-route';
import type { DisclosureService } from './disclosure/disclosure-service';
import type { ClarificationService } from './disclosure/clarification-service';
import type { DisclosureTransmissionRepository } from './db/repositories/disclosure-transmission-repository';
import type { ClarificationRepository } from './db/repositories/clarification-repository';
import { generationRoute } from './routes/generation-route';
import type { GenerationService } from './generation/index';
import { verificationRoute, type VerificationRouteDependencies } from './routes/verification-route';
import { runtimeRoute, type RuntimeRouteDependencies } from './routes/runtime-route';

export interface AppDependencies {
  logger: Logger;
  dataRoot: string;
  version: string;
  getSchemaVersion(): string;
  /** Resolved application paths; the agent routes read every pinned Pi location from these. */
  paths: AppPaths;
  /** Agent seams the server composes for itself in production and tests inject. */
  agent?: Pick<AgentRouteDependencies, 'probe' | 'runSmoke' | 'configStore'>;
  conversation?: Pick<
    TaskRouteDependencies,
    'tasks' | 'executions' | 'registry' | 'disclosure' | 'preflight' | 'consents'
  > &
    Pick<ExecutionRouteDependencies, 'events'>;
  serverConfig?: ServerConfig;
  /** File ingestion (FEAT-104); mounted with the conversation routes. */
  ingestion?: { uploads: UploadService };
  disclosure?: { service: DisclosureService; transmissions: DisclosureTransmissionRepository; consents: import('./db/repositories/disclosure-consent-repository').DisclosureConsentRepository; clarifications: ClarificationRepository; clarificationService: ClarificationService };
  /** Code versions, attempts, fixtures, and guidance retries (FEAT-106); mounted with the conversation routes. */
  generation?: { service: GenerationService };
  /** Verification, the approval gate, the real run, and the review (FEAT-107); mounted with the conversation routes. */
  verification?: Omit<VerificationRouteDependencies, 'config'>;
  runtime?: Omit<RuntimeRouteDependencies, 'config'>;
  configureRoutes?: (app: Express) => void;
}

/** Create the HTTP application. @param deps Logger, metadata probe, application paths, and public settings. @returns An Express instance without a network listener. */
export function createApp(deps: AppDependencies): Express {
  const app = express();
  app.use(correlationId(deps.logger));
  app.use(express.json({ limit: '1mb' }));
  app.use(healthRoute(deps));
  if (deps.serverConfig) {
    const guard = originGuard(deps.serverConfig);
    app.use((request, response, next) =>
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)
        ? guard(request, response, next)
        : next(),
    );
    if (deps.runtime) app.use(runtimeRoute({ ...deps.runtime, config: deps.serverConfig }));
  }
  app.use(
    agentRoute({
      paths: deps.paths,
      configStore:
        deps.agent?.configStore ??
        new AgentConfigStore({ paths: deps.paths, logger: deps.logger }),
      logger: deps.logger,
      ...(deps.agent?.probe !== undefined ? { probe: deps.agent.probe } : {}),
      ...(deps.agent?.runSmoke !== undefined
        ? { runSmoke: deps.agent.runSmoke }
        : {}),
    }),
  );
  if (deps.conversation && deps.serverConfig) {
    app.use(
      taskRoute({
        ...deps.conversation,
        config: deps.serverConfig,
        ...(deps.ingestion ? { uploads: deps.ingestion.uploads } : {}),
        ...(deps.disclosure ? { disclosure: deps.disclosure.service } : {}),
      }),
    );
    if (deps.ingestion)
      app.use(
        uploadRoute({
          uploads: deps.ingestion.uploads,
          tasks: deps.conversation.tasks,
          config: deps.serverConfig,
        }),
      );
    app.use(
      executionRoute({ ...deps.conversation, config: deps.serverConfig }),
    );
    if (deps.disclosure) {
      app.use(disclosureRoute({ disclosure: deps.disclosure.service, transmissions: deps.disclosure.transmissions, consents: deps.disclosure.consents }));
      app.use(clarificationRoute({ clarifications: deps.disclosure.clarifications, service: deps.disclosure.clarificationService }));
    }
    if (deps.generation) app.use(generationRoute({ generation: deps.generation.service, config: deps.serverConfig }));
    if (deps.verification) app.use(verificationRoute({ ...deps.verification, config: deps.serverConfig }));
  }
  deps.configureRoutes?.(app);
  app.use((_request, _response, next) =>
    next(
      new AutoMateError(
        ERROR_CODES.NOT_FOUND,
        'The requested page was not found.',
      ),
    ),
  );
  app.use(errorHandler(deps.logger));
  return app;
}
