/**
 * The app-owned Pi runtime environment (FEAT-102 TASK-004).
 *
 * Every Pi path is pinned under the Auto-Mate data root and settings are
 * supplied in memory — the developer's interactive `~/.pi` installation and any
 * project-local `.pi/settings.json` are never consulted. The resource loader is
 * fully controlled: it yields exactly the caller-supplied system prompt and
 * zero extensions, skills, prompt templates, themes, and context files.
 *
 * Pointing auth at an existing personal Pi `auth.json` is an explicit,
 * documented opt-in (`auth.mode: 'personal-pi'`). It changes the auth path and
 * nothing else — `enumerate()` is the assertable evidence of that.
 */

import { DefaultResourceLoader, ModelRuntime, SettingsManager, type ResourceLoader } from '@earendil-works/pi-coding-agent';
import type { AgentAuthSelection, AgentAuthSource } from '@automate/core';

/** Where the credential authenticating a session came from, including the absent case. */
export type PiAuthSource = AgentAuthSource | 'unavailable';

/** Factory for the pinned model runtime. Tests inject a spy so no test ever reaches the network. */
export type ModelRuntimeFactory = (options: {
  authPath: string;
  modelsPath: string;
  allowModelNetwork: boolean;
  signal?: AbortSignal;
}) => Promise<ModelRuntime>;

/** Options for {@link createPiEnvironment}. */
export interface PiEnvironmentOptions {
  /** Pinned Pi config root, `<dataRoot>/pi`. */
  readonly piDir: string;
  /** Effective credential file: the managed store, or the personal opt-in path. */
  readonly authPath: string;
  /** Pinned custom/local model definitions, `<dataRoot>/pi/models.json`. */
  readonly modelsPath: string;
  /** Pinned staging directory for sessions not yet placed under an execution. */
  readonly sessionStagingDir: string;
  /** Working directory recorded for the session. Never used for resource discovery. */
  readonly cwd: string;
  /** The complete system prompt — the only prompt source the loader yields. */
  readonly systemPrompt: string;
  /** Provider key used for credential status resolution. */
  readonly provider: string;
  /** Configured credential selection; decides how a stored credential is labelled. */
  readonly auth: AgentAuthSelection;
  /** Caller cancellation for runtime construction. */
  readonly signal?: AbortSignal;
  /** Runtime factory override (tests). */
  readonly createModelRuntime?: ModelRuntimeFactory;
}

/** Effective paths and resources of a constructed environment — the isolation evidence surface. */
export interface PiEnvironmentEnumeration {
  readonly agentDir: string;
  readonly authPath: string;
  readonly modelsPath: string;
  readonly sessionStagingDir: string;
  /** Settings never come from disk. */
  readonly settingsSource: 'in-memory';
  readonly systemPrompt: string | undefined;
  readonly appendSystemPrompt: readonly string[];
  readonly extensions: readonly string[];
  readonly skills: readonly string[];
  readonly prompts: readonly string[];
  readonly themes: readonly string[];
  readonly contextFiles: readonly string[];
}

/** A fully constructed, pinned Pi runtime environment. */
export interface PiEnvironment {
  readonly agentDir: string;
  readonly authPath: string;
  readonly modelsPath: string;
  readonly sessionStagingDir: string;
  readonly modelRuntime: ModelRuntime;
  readonly settingsManager: SettingsManager;
  readonly resourceLoader: ResourceLoader;
  /** Which credential source will authenticate this session. */
  readonly authSource: PiAuthSource;
  /** Enumerate the effective paths and resources. @returns The evidence the isolation claim is asserted against. @example environment.enumerate().skills */
  enumerate(): PiEnvironmentEnumeration;
}

/** Construct the pinned runtime. Keeping `allowModelNetwork` false means opening a session never quietly fetches a catalog. */
const defaultCreateModelRuntime: ModelRuntimeFactory = (options) => ModelRuntime.create(options);

/**
 * Normalize Pi's credential-source vocabulary onto Auto-Mate's.
 *
 * Pi quirk: `AuthStatus.configured` is true only for credentials stored in
 * `auth.json`; runtime and environment keys report `configured: false` but
 * carry a `source`. A present source therefore means a usable credential exists.
 *
 * @param runtime The constructed model runtime.
 * @param provider Provider key to resolve.
 * @param mode The configured credential selection, which labels a stored credential.
 * @returns The effective source, or `unavailable` when nothing resolves.
 * @example resolveAuthSource(runtime, 'anthropic', 'managed')
 */
export function resolveAuthSource(
  runtime: Pick<ModelRuntime, 'getProviderAuthStatus'>,
  provider: string,
  mode: AgentAuthSelection['mode'],
): PiAuthSource {
  const stored: AgentAuthSource = mode === 'personal-pi' ? 'personal-pi' : 'managed';
  let status;
  try { status = runtime.getProviderAuthStatus(provider); }
  catch { return 'unavailable'; }
  switch (status.source) {
    case 'stored':
    case 'runtime':
      return stored;
    case 'environment':
    case 'fallback':
      return 'environment';
    case 'models_json_key':
    case 'models_json_command':
      return 'managed';
    default:
      return status.configured ? stored : 'unavailable';
  }
}

/**
 * Build a pinned, app-owned Pi environment.
 *
 * @param options Pinned paths, the working directory, the system prompt, and the credential selection.
 * @returns The constructed environment with its runtime, in-memory settings, and a reloaded controlled resource loader.
 * @example await createPiEnvironment({ piDir, authPath, modelsPath, sessionStagingDir, cwd, systemPrompt, provider, auth })
 */
export async function createPiEnvironment(options: PiEnvironmentOptions): Promise<PiEnvironment> {
  const createRuntime = options.createModelRuntime ?? defaultCreateModelRuntime;
  const modelRuntime = await createRuntime({
    authPath: options.authPath,
    modelsPath: options.modelsPath,
    // A local-first app must not make a network call the user did not ask for.
    allowModelNetwork: false,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });

  // In-memory settings with pinned overrides. Never `SettingsManager.create`,
  // which reads `~/.pi` and the project directory from disk.
  const settingsManager = SettingsManager.inMemory(
    {
      compaction: { enabled: true },
      defaultProjectTrust: 'never',
      enableAnalytics: false,
      enableInstallTelemetry: false,
      enableSkillCommands: false,
      quietStartup: true,
      sessionDir: options.sessionStagingDir,
    },
    { projectTrusted: false },
  );

  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.piDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: options.systemPrompt,
    // Belt and braces: even if a discovery path slipped past the no-* flags,
    // the overrides force the caller-supplied prompt and nothing else.
    systemPromptOverride: () => options.systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();

  const enumerate = (): PiEnvironmentEnumeration => ({
    agentDir: options.piDir,
    authPath: options.authPath,
    modelsPath: options.modelsPath,
    sessionStagingDir: options.sessionStagingDir,
    settingsSource: 'in-memory',
    systemPrompt: resourceLoader.getSystemPrompt(),
    appendSystemPrompt: resourceLoader.getAppendSystemPrompt(),
    extensions: resourceLoader.getExtensions().extensions.map((extension) => extension.path),
    skills: resourceLoader.getSkills().skills.map((skill) => skill.name),
    prompts: resourceLoader.getPrompts().prompts.map((prompt) => prompt.name),
    themes: resourceLoader.getThemes().themes.map((theme) => theme.name ?? 'unnamed'),
    contextFiles: resourceLoader.getAgentsFiles().agentsFiles.map((file) => file.path),
  });

  return {
    agentDir: options.piDir,
    authPath: options.authPath,
    modelsPath: options.modelsPath,
    sessionStagingDir: options.sessionStagingDir,
    modelRuntime,
    settingsManager,
    resourceLoader,
    authSource: resolveAuthSource(modelRuntime, options.provider, options.auth.mode),
    enumerate,
  };
}
