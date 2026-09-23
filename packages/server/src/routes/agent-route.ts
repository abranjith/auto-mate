import { Router } from 'express';
import { Value } from '@sinclair/typebox/value';
import {
  AgentConfigInvalidError, AgentConfigUpdateSchema, AgentModelNotFoundError, AgentStartupError,
  ConfigurationError, ERROR_CODES, ValidationError,
  type AgentConfig, type AgentConfigUpdate, type ConnectionTestResponse, type ProviderCatalogResponse,
} from '@automate/core';
import type { Logger } from 'pino';
import type { AppPaths } from '../config/app-paths';
import { AgentConfigStore, probeProviders, resolveAuthPath, runAgentSmoke, type AgentSmokeOptions } from '../agent/index';

/**
 * How long one connection test may run before it is aborted.
 *
 * Measured against a real provider, a cold first call took ~86 s (a warm one
 * ~24 s), so the bound is set well clear of that. It exists to stop a hung
 * provider holding the request open forever, not to police slow models.
 */
const CONNECTION_TEST_TIMEOUT_MS = 180_000;

/** Dependencies for {@link agentRoute}. */
export interface AgentRouteDependencies {
  /** Resolved application paths supplying every pinned Pi location. */
  readonly paths: AppPaths;
  /** The app-owned agent configuration store. */
  readonly configStore: AgentConfigStore;
  /** Logger for configuration and connection-test events. */
  readonly logger: Logger;
  /** Smoke runner override (tests); production uses the real one. */
  readonly runSmoke?: typeof runAgentSmoke;
  /** Provider probe override (tests); production uses the real one. */
  readonly probe?: typeof probeProviders;
}

/** Name the first schema violation in a rejected body, so the message is actionable. */
function describeFirstError(body: unknown): string {
  const [first] = [...Value.Errors(AgentConfigUpdateSchema, body)];
  if (first === undefined) return 'the request body did not match the expected shape';
  const field = first.path.replace(/^\//, '').replace(/\//g, '.') || 'the request body';
  return `"${field}" is invalid (${first.message})`;
}

/** Count normalized events by type, for the connection-test summary. */
function countEvents(events: readonly { type: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
  return counts;
}

/**
 * Build the agent settings endpoints.
 *
 * `GET`/`PUT /api/agent/config` read and write the app-owned selection,
 * `GET /api/agent/providers` reports credential status, and
 * `POST /api/agent/test-connection` opens one real session. No response carries
 * a credential value, and every error flows through the shared envelope with
 * its correlation id — no handler formats an error body itself.
 *
 * @param deps Application paths, the config store, the logger, and the test seams.
 * @returns A router mounted by `createApp`.
 * @example app.use(agentRoute({ paths, configStore, logger }))
 */
export function agentRoute(deps: AgentRouteDependencies): Router {
  const router = Router();
  const probe = deps.probe ?? probeProviders;
  const smoke = deps.runSmoke ?? runAgentSmoke;

  /** Resolve the credential path, degrading a missing personal file to the managed store for status-only reads. */
  const authPathForStatus = (config: AgentConfig): string => {
    try { return resolveAuthPath(config, deps.paths); }
    catch { return deps.paths.piAuthFile; }
  };

  /** Read the provider catalog for one credential selection. */
  const catalog = async (config: AgentConfig): Promise<ProviderCatalogResponse> => {
    const providers = await probe({ authPath: authPathForStatus(config), modelsPath: deps.paths.piModelsFile, config });
    return { providers: providers.map((entry) => ({ ...entry, models: entry.models.map((model) => ({ ...model })) })) };
  };

  router.get('/api/agent/config', (_request, response, next) => {
    try { response.json(deps.configStore.load()); }
    catch (cause) { next(cause); }
  });

  router.put('/api/agent/config', (request, response, next) => {
    void (async () => {
      try {
        const body: unknown = request.body;
        if (!Value.Check(AgentConfigUpdateSchema, body)) {
          throw new ValidationError(`The agent configuration could not be saved: ${describeFirstError(body)}.`);
        }
        const candidate: AgentConfig = { ...deps.configStore.load(), ...(body as AgentConfigUpdate) };
        if (candidate.auth.mode === 'personal-pi') {
          // The shape was fine but the target does not exist: a configuration
          // problem, reported with its own code so the page can say so.
          try { resolveAuthPath(candidate, deps.paths); }
          catch (cause) { throw new AgentConfigInvalidError(cause instanceof ConfigurationError ? cause.message : 'The personal Pi credential file you selected could not be read.'); }
        }
        const entry = (await catalog(candidate)).providers.find((provider) => provider.id === candidate.provider);
        const ids = entry?.models.map((model) => model.id) ?? [];
        if (ids.length > 0 && !ids.includes(candidate.model)) {
          throw new AgentModelNotFoundError(candidate.provider, candidate.model, `Known ${candidate.provider} models include: ${ids.slice(0, 8).join(', ')}.`);
        }
        response.json(deps.configStore.save(candidate));
      } catch (cause) { next(cause); }
    })();
  });

  router.get('/api/agent/providers', (_request, response, next) => {
    void (async () => {
      try { response.json(await catalog(deps.configStore.load())); }
      catch (cause) { next(cause); }
    })();
  });

  router.post('/api/agent/test-connection', (_request, response, next) => {
    void (async () => {
      const config = deps.configStore.load();
      const startedAt = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CONNECTION_TEST_TIMEOUT_MS);
      try {
        const options: AgentSmokeOptions = {
          piDir: deps.paths.piDir,
          authPath: resolveAuthPath(config, deps.paths),
          modelsPath: deps.paths.piModelsFile,
          sessionStagingDir: deps.paths.piSessionStagingDir,
          sessionDir: deps.paths.sessionDirFor(`connection-test-${Date.now()}`),
          executionId: 'connection-test',
          model: { provider: config.provider, id: config.model, ...(config.thinking !== undefined ? { thinking: config.thinking } : {}) },
          auth: config.auth,
          logger: deps.logger,
          signal: controller.signal,
        };
        const report = await smoke(options);
        const completed = report.result.outcome === 'completed';
        response.json({
          ok: completed,
          model: config.model,
          provider: config.provider,
          authSource: report.authSource,
          sessionId: report.sessionId,
          durationMs: Date.now() - startedAt,
          eventCounts: countEvents(report.events),
          statusToolInvoked: report.statusToolInvoked,
          ...(completed ? {} : { error: { code: ERROR_CODES.AGENT_PROVIDER_UNAVAILABLE, message: `The session ended with outcome "${report.result.outcome}".` } }),
        } satisfies ConnectionTestResponse);
      } catch (cause) {
        // A typed startup failure is a reportable test outcome, not a server
        // fault: the page renders it as a failed test with the fix.
        if (cause instanceof AgentStartupError) {
          deps.logger.warn({ code: cause.code, correlationId: response.locals.correlationId }, 'connection test could not start a session');
          response.json({
            ok: false, model: config.model, provider: config.provider,
            durationMs: Date.now() - startedAt, eventCounts: {}, statusToolInvoked: false,
            error: { code: cause.code, message: cause.message },
          } satisfies ConnectionTestResponse);
          return;
        }
        next(cause);
      } finally {
        clearTimeout(timeout);
      }
    })();
  });

  return router;
}
