import { AgentStartupError } from '@automate/core';
import { AgentConfigStore, resolveAuthPath, runAgentSmoke } from '../agent/index';
import { ensureAppDirectories, getAppPaths } from '../config/app-paths';
import { createLogger } from '../logging/logger';
import { formatDoctor, runDoctor } from './doctor';

/**
 * Open one real agent session, call the `status` tool once, and print the
 * normalized events. Exits non-zero on any typed startup failure, so a missing
 * credential is loud and immediate rather than a hang or a silent fallback.
 *
 * @returns The process exit code: 0 on a completed round trip.
 */
async function agentSmoke(): Promise<number> {
  const paths = getAppPaths();
  ensureAppDirectories(paths);
  const logger = createLogger(process.env.LOG_LEVEL || 'warn');
  const config = new AgentConfigStore({ paths, logger }).load();
  const controller = new AbortController();
  const interrupt = (): void => { console.log('\nAborting the agent session…'); controller.abort(); };
  process.once('SIGINT', interrupt);

  console.log(`Opening a session with ${config.provider} / ${config.model}${config.thinking ? ` (thinking: ${config.thinking})` : ''}…`);
  try {
    const report = await runAgentSmoke({
      piDir: paths.piDir,
      authPath: resolveAuthPath(config, paths),
      modelsPath: paths.piModelsFile,
      sessionStagingDir: paths.piSessionStagingDir,
      sessionDir: paths.sessionDirFor('agent-smoke'),
      executionId: 'agent-smoke',
      model: { provider: config.provider, id: config.model, ...(config.thinking !== undefined ? { thinking: config.thinking } : {}) },
      auth: config.auth,
      logger,
      signal: controller.signal,
      onEvent: (event) => console.log(`  ${event.type}${event.type === 'tool_started' || event.type === 'tool_finished' ? ` (${event.tool})` : ''}`),
    });
    console.log(`\nsession      ${report.sessionId}`);
    console.log(`credential   ${report.authSource}`);
    console.log(`status tool  ${report.statusToolInvoked ? 'called and returned' : 'NOT called'}`);
    console.log(`outcome      ${report.result.outcome} (${report.result.stopReason})`);
    console.log(`usage        ${JSON.stringify(report.result.usage)}`);
    console.log(`log          ${report.logPath}`);
    console.log(`ambient      ${report.environment.extensions.length} extensions, ${report.environment.skills.length} skills, ${report.environment.prompts.length} prompts, ${report.environment.themes.length} themes, ${report.environment.contextFiles.length} context files`);
    console.log(`prompt       ${report.promptVersion}`);
    return report.result.outcome === 'completed' && report.statusToolInvoked ? 0 : 1;
  } catch (cause) {
    if (cause instanceof AgentStartupError) {
      console.error(`\n${cause.code}: ${cause.message}`);
      return 1;
    }
    throw cause;
  } finally {
    process.off('SIGINT', interrupt);
  }
}

if (process.argv.includes('--agent-smoke')) {
  process.exitCode = await agentSmoke();
} else {
  const report = runDoctor();
  console.log(formatDoctor(report));
  if (!report.ok) process.exitCode = 1;
}
