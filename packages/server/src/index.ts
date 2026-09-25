import { createApp } from './app';
import { getAppPaths, ensureAppDirectories } from './config/app-paths';
import { getIngestionConfig, getServerConfig } from './config/env';
import { openDatabase } from './db/client';
import { migrateDatabase } from './db/migrate';
import { AppMetaRepository } from './db/repositories/app-meta-repository';
import { createLogger } from './logging/logger';
import { assertPreflight, runDoctor } from './preflight/doctor';
import { AgentConfigStore, createAgentProvider } from './agent/index';
import { ConversationEventRepository } from './db/repositories/conversation-event-repository';
import { ExecutionRepository } from './db/repositories/execution-repository';
import { TaskRepository } from './db/repositories/task-repository';
import { TaskSessionRegistry } from './conversation/index';
import { attachExecutionSocket } from './ws/index';
import { UploadProfileRepository } from './db/repositories/upload-profile-repository';
import { UploadRepository } from './db/repositories/upload-repository';
import { DisclosureConsentRepository } from './db/repositories/disclosure-consent-repository';
import { DisclosureTransmissionRepository } from './db/repositories/disclosure-transmission-repository';
import { ClarificationRepository } from './db/repositories/clarification-repository';
import { ClarificationService, DisclosureRunStrategy, DisclosureService, PreflightService, createClarificationTool } from './disclosure/index';
import {
  ProfileService,
  StagedUploadSweeper,
  UploadFileStore,
  UploadService,
} from './ingestion/index';

const config = getServerConfig();
const ingestionLimits = getIngestionConfig();
const logger = createLogger(config.logLevel);

/** Start the local preview. @returns Resolves once listening; opens storage and a loopback listener after preflight. */
async function start(): Promise<void> {
  const report = runDoctor();
  for (const check of report.checks.filter(
    (item) => !item.ok && item.severity === 'warning',
  ))
    logger.warn(
      { prerequisite: check.name },
      `${check.message} ${check.hint ?? ''}`,
    );
  assertPreflight(report);
  logger.info({ checks: report.checks.length }, 'preflight complete');
  const paths = getAppPaths();
  ensureAppDirectories(paths);
  logger.info({ dataRoot: paths.root }, 'application data root resolved');
  const connection = openDatabase(paths);
  try {
    migrateDatabase(connection);
    logger.info('database migrations applied');
    const meta = new AppMetaRepository(connection);
    const configStore = new AgentConfigStore({ paths, logger });
    const executions = new ExecutionRepository(connection);
    const events = new ConversationEventRepository(connection);
    const tasks = new TaskRepository(connection);
    const provider = createAgentProvider({ paths, configStore, logger });
    const uploadRows = new UploadRepository(connection);
    const uploadProfiles = new UploadProfileRepository(connection);
    const consents = new DisclosureConsentRepository(connection);
    const transmissions = new DisclosureTransmissionRepository(connection);
    const clarifications = new ClarificationRepository(connection);
    const disclosure = new DisclosureService({ uploads: uploadRows, profiles: uploadProfiles, consents, configStore, maxPreflightDecisions: config.maxPreflightDecisions });
    const preflight = new PreflightService(uploadProfiles, clarifications, config.maxPreflightDecisions);
    const registryRef: { current?: TaskSessionRegistry } = {};
    const clarificationService = new ClarificationService({
      clarifications,
      executions,
      events,
      maxAgentClarifications: config.maxAgentClarifications ?? 3,
      maxWaitingExecutions: config.maxWaitingExecutions ?? 5,
      waitingCount: () => registryRef.current?.waitingCount() ?? 0,
      publish: (executionId, event) => registryRef.current?.publish(executionId, event),
    });
    const strategy = new DisclosureRunStrategy({
      disclosure,
      transmissions,
      uploads: uploadRows,
      clarifications,
      executions,
      clarificationTool: createClarificationTool(clarificationService),
      maxDiagnosticBytes: config.maxDiagnosticBytes,
      publish: (executionId, event) => registryRef.current?.publish(executionId, event),
    });
    const registry = new TaskSessionRegistry({
      provider,
      executions,
      events,
      strategy,
      paths,
      logger,
      maxConcurrentExecutions: config.maxConcurrentExecutions,
      clarifications: clarificationService,
      model: () => {
        const saved = configStore.load();
        return {
          provider: saved.provider,
          id: saved.model,
          ...(saved.thinking ? { thinking: saved.thinking } : {}),
        };
      },
      auth: () => configStore.load().auth,
    });
    registryRef.current = registry;
    registry.reconcileOnStartup();
    const fileStore = new UploadFileStore(paths);
    const uploads = new UploadService({
      uploads: uploadRows,
      profiles: uploadProfiles,
      store: fileStore,
      profiler: new ProfileService({ uploads: uploadRows, profiles: uploadProfiles, store: fileStore, limits: ingestionLimits, logger }),
      limits: ingestionLimits,
      logger,
    });
    const sweeper = new StagedUploadSweeper({
      uploads: uploadRows,
      tasks,
      store: fileStore,
      ttlHours: ingestionLimits.stagedUploadTtlHours,
      logger,
    });
    // Orphan cleanup runs before the listener binds, alongside reconciliation, then hourly.
    await sweeper.sweep();
    sweeper.start();
    const app = createApp({
      logger,
      dataRoot: paths.root,
      version: '0.1.0',
      paths,
      getSchemaVersion: () => meta.getSchemaVersion(),
      agent: { configStore },
      conversation: { tasks, executions, events, registry, disclosure, preflight, consents },
      serverConfig: config,
      ingestion: { uploads },
      disclosure: { service: disclosure, transmissions, consents, clarifications, clarificationService },
    });
    const server = app.listen(config.port, config.host, () =>
      logger.info(
        { url: `http://${config.host}:${config.port}` },
        'server listening',
      ),
    );
    const detachSockets = attachExecutionSocket(server, {
      executions,
      events,
      registry,
      config,
      logger,
    });
    const shutdown = () => {
      sweeper.stop();
      void registry.drain(5_000).finally(() => {
        detachSockets();
        server.close(() => {
          connection.close();
          process.exitCode = 0;
        });
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (cause) {
    connection.close();
    throw cause;
  }
}

start().catch((cause: unknown) => {
  logger.error({ err: cause }, 'startup failed');
  process.exitCode = 1;
});
