import { ConfigurationError, MAX_AGENT_CLARIFICATIONS, MAX_DIAGNOSTIC_BYTES, MAX_PREFLIGHT_DECISIONS, UPLOAD_LIMIT_DEFAULTS } from '@automate/core';

export interface ServerConfig {
  host: string;
  port: number;
  logLevel: string;
  maxConcurrentExecutions: number;
  maxWaitingExecutions?: number;
  maxAgentClarifications?: number;
  maxPreflightDecisions?: number;
  maxDiagnosticBytes?: number;
  allowedOrigins: readonly string[];
  nodeEnv: string;
}

/** Parse server settings. @param env Environment variables to read. @returns Validated transport and execution settings. */
export function getServerConfig(env = process.env): ServerConfig {
  const port = Number(env.AUTOMATE_PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new ConfigurationError('AUTOMATE_PORT must be a valid TCP port.');
  const maxConcurrentExecutions = Number(
    env.AUTOMATE_MAX_CONCURRENT_EXECUTIONS ?? 1,
  );
  if (!Number.isInteger(maxConcurrentExecutions) || maxConcurrentExecutions < 1)
    throw new ConfigurationError(
      'AUTOMATE_MAX_CONCURRENT_EXECUTIONS must be a positive integer.',
    );
  const allowedOrigins = (env.AUTOMATE_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    host: env.AUTOMATE_HOST || '127.0.0.1',
    port,
    logLevel: env.LOG_LEVEL || 'info',
    maxConcurrentExecutions,
    maxWaitingExecutions: positiveInteger(env, 'AUTOMATE_MAX_WAITING_EXECUTIONS', 5),
    maxAgentClarifications: positiveInteger(env, 'AUTOMATE_MAX_AGENT_CLARIFICATIONS', MAX_AGENT_CLARIFICATIONS),
    maxPreflightDecisions: positiveInteger(env, 'AUTOMATE_MAX_PREFLIGHT_DECISIONS', MAX_PREFLIGHT_DECISIONS),
    maxDiagnosticBytes: positiveInteger(env, 'AUTOMATE_MAX_DIAGNOSTIC_BYTES', MAX_DIAGNOSTIC_BYTES),
    allowedOrigins,
    nodeEnv: env.NODE_ENV || 'production',
  };
}

/**
 * Ingestion limits (FEAT-104, D14). Every value is PROVISIONAL: D14 remains
 * open, and these defaults exist so the preview is bounded, not because they
 * have been validated with users. Each limit error the application raises
 * names both the limit and the actual value.
 */
export interface IngestionConfig {
  /** `AUTOMATE_MAX_UPLOAD_BYTES` — largest accepted file, checked while it streams. */
  maxUploadBytes: number;
  /** `AUTOMATE_MAX_FILES_PER_TASK` — files one task may hold; may be lowered, not raised above the request schema's 5. */
  maxFilesPerTask: number;
  /** `AUTOMATE_MAX_PROFILE_ROWS` — rows scanned per table before its count becomes a lower bound. */
  maxProfileRows: number;
  /** `AUTOMATE_MAX_COLUMNS` — columns per table. */
  maxColumns: number;
  /** `AUTOMATE_PARSE_TIMEOUT_MS` — wall-clock limit on reading and profiling one file. */
  parseTimeoutMs: number;
  /** `AUTOMATE_MAX_SHEETS` — worksheets profiled per workbook. */
  maxSheets: number;
  /** `AUTOMATE_MAX_INFLATED_BYTES` — how far a workbook may expand when unzipped. */
  maxInflatedBytes: number;
  /** `AUTOMATE_STAGED_UPLOAD_TTL_HOURS` — how long an unattached upload survives before the orphan sweep. */
  stagedUploadTtlHours: number;
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new ConfigurationError(`${name} must be a whole number between 1 and ${max}.`);
  }
  return value;
}

/** Parse the ingestion limits. @param env Environment variables to read. @returns Limits with the D14 provisional defaults. */
export function getIngestionConfig(env = process.env): IngestionConfig {
  const defaults = UPLOAD_LIMIT_DEFAULTS;
  return {
    maxUploadBytes: positiveInteger(env, 'AUTOMATE_MAX_UPLOAD_BYTES', defaults.maxUploadBytes),
    maxFilesPerTask: positiveInteger(env, 'AUTOMATE_MAX_FILES_PER_TASK', defaults.maxFilesPerTask, defaults.maxFilesPerTask),
    maxProfileRows: positiveInteger(env, 'AUTOMATE_MAX_PROFILE_ROWS', defaults.maxProfileRows),
    maxColumns: positiveInteger(env, 'AUTOMATE_MAX_COLUMNS', defaults.maxColumns),
    parseTimeoutMs: positiveInteger(env, 'AUTOMATE_PARSE_TIMEOUT_MS', defaults.parseTimeoutMs),
    maxSheets: positiveInteger(env, 'AUTOMATE_MAX_SHEETS', defaults.maxSheets),
    maxInflatedBytes: positiveInteger(env, 'AUTOMATE_MAX_INFLATED_BYTES', defaults.maxInflatedBytes),
    stagedUploadTtlHours: positiveInteger(env, 'AUTOMATE_STAGED_UPLOAD_TTL_HOURS', defaults.stagedUploadTtlHours),
  };
}
