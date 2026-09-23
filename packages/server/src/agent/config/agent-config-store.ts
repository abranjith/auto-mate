import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { AgentConfigSchema, ConfigurationError, DEFAULT_AGENT_CONFIG, type AgentConfig } from '@automate/core';
import type { Logger } from 'pino';
import type { AppPaths } from '../../config/app-paths';

/** Dependencies for {@link AgentConfigStore}. */
export interface AgentConfigStoreOptions {
  /** Resolved application paths; `agentConfigFile` is the singleton document. */
  readonly paths: AppPaths;
  /** Logger for absent-file and save events. Never logs a path outside the data root. */
  readonly logger: Logger;
}

/** Name the first schema violation in plain English, for a `ConfigurationError` message. */
function describeFirstError(config: unknown): string {
  const [first] = [...Value.Errors(AgentConfigSchema, config)];
  if (first === undefined) return 'the document did not match the expected shape';
  const field = first.path.replace(/^\//, '').replace(/\//g, '.') || 'the document root';
  return `"${field}" is invalid (${first.message})`;
}

/**
 * Load, validate, and atomically save the app-owned agent selection.
 *
 * The file is a singleton: one document, no id, no collection. Writes go to
 * `agent.json.tmp` and are renamed, so a crash mid-write cannot leave a
 * truncated config that bricks startup.
 */
export class AgentConfigStore {
  /** `load()` runs per request; the absent-file notice is worth saying once, not on every read. */
  private reportedMissing = false;

  constructor(private readonly options: AgentConfigStoreOptions) {}

  /** Read the saved selection. @returns The stored config, or the in-memory defaults when no file exists. @throws ConfigurationError naming the offending field when the file is present but invalid. @example store.load().model */
  load(): AgentConfig {
    const file = this.options.paths.agentConfigFile;
    if (!existsSync(file)) {
      if (!this.reportedMissing) {
        this.options.logger.info('no agent configuration file yet; using the built-in defaults');
        this.reportedMissing = true;
      }
      return { ...DEFAULT_AGENT_CONFIG };
    }
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
    catch (cause) { throw new ConfigurationError('The agent configuration file is not readable JSON. Delete it to restore the defaults.', cause); }
    if (!Value.Check(AgentConfigSchema, parsed)) {
      throw new ConfigurationError(`The agent configuration is invalid: ${describeFirstError(parsed)}. Correct it on the Settings page or delete the file to restore the defaults.`);
    }
    return parsed;
  }

  /** Validate and persist a selection atomically. @param config The complete selection to store. @returns The stored config with a fresh `updatedAt`. @throws ConfigurationError when the selection is invalid or cannot be written. @example store.save({ ...current, model: 'claude-opus-5' }) */
  save(config: AgentConfig): AgentConfig {
    const stamped: AgentConfig = { ...config, version: DEFAULT_AGENT_CONFIG.version, updatedAt: new Date().toISOString() };
    if (!Value.Check(AgentConfigSchema, stamped)) {
      throw new ConfigurationError(`The agent configuration is invalid: ${describeFirstError(stamped)}.`);
    }
    const file = this.options.paths.agentConfigFile;
    const temporary = `${file}.tmp`;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(temporary, `${JSON.stringify(stamped, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(temporary, file);
      this.reportedMissing = false;
    } catch (cause) {
      // A failed write must leave the previous valid file intact.
      rmSync(temporary, { force: true });
      throw new ConfigurationError('The agent configuration could not be saved. Check that the application data directory is writable.', cause);
    }
    this.options.logger.info({ provider: stamped.provider, model: stamped.model, thinking: stamped.thinking, authMode: stamped.auth.mode }, 'agent configuration saved');
    return stamped;
  }
}

/** Resolve the credential file a configuration points at. @param config The saved selection. @param paths Resolved application paths. @returns The managed store path, or the configured personal path. @throws ConfigurationError when a configured personal path does not exist. @example resolveAuthPath(store.load(), paths) */
export function resolveAuthPath(config: AgentConfig, paths: AppPaths): string {
  if (config.auth.mode === 'managed') return paths.piAuthFile;
  const configured = path.resolve(config.auth.authPath);
  if (!existsSync(configured)) {
    throw new ConfigurationError('The personal Pi credential file you selected does not exist. Check the path on the Settings page, or switch back to the managed credential store.');
  }
  return configured;
}
