/**
 * Offline credential and model catalog probe (FEAT-102 TASK-009).
 *
 * The probe opens no session, makes no network call, and never reads a
 * credential VALUE. It asks the runtime for status only. The returned shape is
 * constructed so that it has no field capable of holding key material — a test
 * asserts that by pattern-matching the serialized result.
 *
 * Any unreadable source is reported as unavailable rather than thrown on: a
 * broken credential store must degrade into an honest "not configured" in the
 * UI, not a 500.
 */

import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { AgentConfig } from '@automate/core';
import { resolveAuthSource, type ModelRuntimeFactory, type PiAuthSource } from './environment';

/** One provider's configuration status. Contains no credential material by construction. */
export interface ProviderCatalogEntry {
  /** Provider key, for example `anthropic`. */
  readonly id: string;
  /** Human-readable provider name for the settings page. */
  readonly label: string;
  /** True when some credential source resolves for this provider. */
  readonly credentialAvailable: boolean;
  /** Where that credential comes from, or `unavailable`. */
  readonly credentialSource: PiAuthSource;
  /** The models this runtime knows for the provider. Empty, never undefined. */
  readonly models: readonly { readonly id: string; readonly label: string }[];
  /** Present only when no credential resolves: the concrete step that fixes it. */
  readonly remediation?: string;
}

/** Options for {@link probeProviders}. */
export interface ProbeProvidersOptions {
  /** Effective credential file: the managed store, or the personal opt-in path. */
  readonly authPath: string;
  /** Pinned custom/local model definitions. */
  readonly modelsPath: string;
  /** The saved selection, whose auth mode labels a stored credential. */
  readonly config: AgentConfig;
  /** Host platform, which decides the shell syntax in the remediation text. */
  readonly platform?: NodeJS.Platform;
  /** Runtime factory override (tests). */
  readonly createModelRuntime?: ModelRuntimeFactory;
}

/** The provider environment variable Pi reads for each known provider key. */
const PROVIDER_ENV_VARS: Readonly<Record<string, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  xai: 'XAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  zai: 'ZAI_API_KEY',
};

/** Turn a provider key into something a person reads comfortably. */
function labelFor(id: string): string {
  const known: Readonly<Record<string, string>> = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', xai: 'xAI', zai: 'Z.ai', openrouter: 'OpenRouter', groq: 'Groq', cerebras: 'Cerebras', ollama: 'Ollama' };
  return known[id] ?? id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Name the concrete step that supplies a credential on this host. */
function remediationFor(id: string, platform: NodeJS.Platform): string {
  const variable = PROVIDER_ENV_VARS[id] ?? `${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
  const setCommand = platform === 'win32' ? `setx ${variable} "your-key"` : `export ${variable}="your-key"`;
  return `No credential found. Set ${variable} in the environment Auto-Mate starts in (${setCommand}), or run "pi" and sign in so the managed credential store holds one. Auto-Mate never asks you to paste a key into this page.`;
}

/** The subset of the runtime this probe consults. Status only — never a credential value. */
type ProbeRuntime = Pick<ModelRuntime, 'getProviders' | 'getModels' | 'getProviderAuthStatus'>;

/** Read one provider's status, degrading an unreadable source into an honest `unavailable`. */
function entryFor(runtime: ProbeRuntime, id: string, mode: AgentConfig['auth']['mode'], platform: NodeJS.Platform): ProviderCatalogEntry {
  const credentialSource = resolveAuthSource(runtime, id, mode);
  const credentialAvailable = credentialSource !== 'unavailable';
  let models: { id: string; label: string }[];
  try { models = runtime.getModels(id).map((model) => ({ id: model.id, label: model.name ?? model.id })); }
  catch { models = []; }
  return {
    id,
    label: labelFor(id),
    credentialAvailable,
    credentialSource,
    models,
    ...(credentialAvailable ? {} : { remediation: remediationFor(id, platform) }),
  };
}

/**
 * Report every provider the runtime knows, with its credential status and models.
 *
 * @param options The pinned credential and model paths, the saved selection, and the optional test seams.
 * @returns One entry per provider, sorted by id. Never contains a credential value.
 * @example (await probeProviders({ authPath, modelsPath, config })).filter((entry) => entry.credentialAvailable)
 */
export async function probeProviders(options: ProbeProvidersOptions): Promise<ProviderCatalogEntry[]> {
  const create = options.createModelRuntime ?? ((runtimeOptions) => ModelRuntime.create(runtimeOptions));
  const platform = options.platform ?? process.platform;
  let runtime: ProbeRuntime;
  try {
    runtime = await create({
      authPath: options.authPath,
      modelsPath: options.modelsPath,
      // Status only: the probe must never reach the network to refresh a catalog.
      allowModelNetwork: false,
    });
  } catch {
    // An unreadable credential store or models file must not become a 500.
    return [];
  }
  let ids: string[];
  try { ids = runtime.getProviders().map((provider) => provider.id); }
  catch { return []; }
  return ids.sort().map((id) => entryFor(runtime, id, options.config.auth.mode, platform));
}
