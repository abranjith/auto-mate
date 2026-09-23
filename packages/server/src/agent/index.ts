/**
 * The agent barrel — the ONLY module the rest of the server imports.
 *
 * Everything Pi-specific lives under `adapters/pi/` and is confined there by
 * lint rule and by the boundary test in `src/__tests__/agent-boundary.test.ts`.
 * A consumer that needs an agent session asks for one here and never learns
 * which SDK is behind it.
 */

import { homedir } from 'node:os';
import type { AgentProvider, AgentSessionOptions } from '@automate/core';
import type { Logger } from 'pino';
import type { AppPaths } from '../config/app-paths';
import { PiAgentProvider, type PiAgentProviderOptions } from './adapters/pi/provider';
import { AgentConfigStore, resolveAuthPath } from './config/agent-config-store';

export { AgentConfigStore, resolveAuthPath } from './config/agent-config-store';
export type { AgentConfigStoreOptions } from './config/agent-config-store';
export { probeProviders } from './adapters/pi/credential-probe';
export type { ProviderCatalogEntry, ProbeProvidersOptions } from './adapters/pi/credential-probe';
export { runAgentSmoke, AGENT_SMOKE_PROMPT_VERSION, createStatusTool } from './adapters/pi/smoke';
export type { AgentSmokeOptions, AgentSmokeReport } from './adapters/pi/smoke';
export { FakeAgentProvider, FakeAgentSession } from './testing/fake-agent-provider';
export type { FakeAgentScript } from './testing/fake-agent-provider';

/** Dependencies for {@link createAgentProvider}. */
export interface AgentProviderDependencies {
  /** Resolved application paths supplying every pinned Pi location. */
  readonly paths: AppPaths;
  /** The saved agent selection, consulted to resolve the credential file. */
  readonly configStore: AgentConfigStore;
  /** Logger for session lifecycle events. */
  readonly logger: Logger;
  /** Custom tools registered for every session. Pi's built-ins stay disabled either way. */
  readonly customTools?: PiAgentProviderOptions['customTools'];
  /** Test seams forwarded to the adapter; production callers omit these. */
  readonly overrides?: Pick<PiAgentProviderOptions, 'createSession' | 'createModelRuntime' | 'mapContext'>;
}

/**
 * Build the server's agent provider.
 *
 * @param deps Application paths, the config store, the logger, and any custom tools.
 * @returns An `AgentProvider` whose sessions expose only the seam.
 * @example const session = await createAgentProvider({ paths, configStore, logger }).open(options)
 */
export function createAgentProvider(deps: AgentProviderDependencies): AgentProvider {
  return new PiAgentProvider({
    piDir: deps.paths.piDir,
    modelsPath: deps.paths.piModelsFile,
    sessionStagingDir: deps.paths.piSessionStagingDir,
    resolveAuthPath: (auth: AgentSessionOptions['auth']) =>
      resolveAuthPath({ ...deps.configStore.load(), auth }, deps.paths),
    logger: deps.logger,
    homeDir: homedir(),
    ...(deps.customTools !== undefined ? { customTools: deps.customTools } : {}),
    ...deps.overrides,
  });
}
