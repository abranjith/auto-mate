import { createApp } from './app';
import { getAppPaths, ensureAppDirectories } from './config/app-paths';
import { getServerConfig } from './config/env';
import { openDatabase } from './db/client';
import { migrateDatabase } from './db/migrate';
import { AppMetaRepository } from './db/repositories/app-meta-repository';
import { createLogger } from './logging/logger';
import { assertPreflight, runDoctor } from './preflight/doctor';

const config = getServerConfig();
const logger = createLogger(config.logLevel);

/** Start the local preview. @returns Nothing; opens storage and a loopback listener after preflight. */
function start(): void {
  const report = runDoctor();
  for (const check of report.checks.filter((item) => !item.ok && item.severity === 'warning')) logger.warn({ prerequisite: check.name }, `${check.message} ${check.hint ?? ''}`);
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
    const app = createApp({ logger, dataRoot: paths.root, version: '0.1.0', paths, getSchemaVersion: () => meta.getSchemaVersion() });
    const server = app.listen(config.port, config.host, () => logger.info({ url: `http://${config.host}:${config.port}` }, 'server listening'));
    const shutdown = () => server.close(() => { connection.close(); process.exitCode = 0; });
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (cause) { connection.close(); throw cause; }
}

try { start(); }
catch (cause) { logger.error({ err: cause }, 'startup failed'); process.exitCode = 1; }
