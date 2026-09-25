import { ConfigurationError, LINT_TIMEOUT_MS, MAX_REVIEW_FEEDBACK_CHARS, MAX_RUN_OUTPUT_BYTES, SCRIPT_RUN_TIMEOUT_MS, SCRIPT_MEMORY_LIMIT_BYTES, SCRIPT_MAX_OUTPUT_FILE_BYTES, SCRIPT_MAX_OUTPUT_TOTAL_BYTES, SCRIPT_MAX_OUTPUT_FILES, OUTPUT_WATCH_INTERVAL_MS, RUNTIME_PREPARE_TIMEOUT_MS, PYTHON_INSTALL_TIMEOUT_MS, SECURITY_TIMEOUT_MS, VERIFICATION_TIMEOUT_MS, FIXTURE_ROW_COUNT, GENERATION_TIMEOUT_MS, MAX_AGENT_CLARIFICATIONS, MAX_DIAGNOSTIC_BYTES, MAX_GENERATION_ATTEMPTS, MAX_GENERATION_COST_USD, MAX_PREFLIGHT_DECISIONS, MAX_SCRIPT_BYTES, TEST_RUN_TIMEOUT_MS, UPLOAD_LIMIT_DEFAULTS, UV_SYNC_TIMEOUT_MS } from '@automate/core';

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

/**
 * Code-generation limits (FEAT-106, D07/D14). Every value is PROVISIONAL
 * against the parts of D14 still open; the attempt default of 3 was confirmed
 * for this row on 2026-09-22. A cost cap of 0 means the cap is OFF.
 */
export interface GenerationConfig {
  /** `AUTOMATE_MAX_GENERATION_ATTEMPTS` — `run_tests` calls per execution, counted in the database. */
  maxAttempts: number;
  /** `AUTOMATE_GENERATION_TIMEOUT_MS` — wall clock across the whole generating phase. */
  timeoutMs: number;
  /** `AUTOMATE_MAX_GENERATION_COST_USD` — provider spend per execution; 0 disables the check. */
  maxCostUsd: number;
  /** `AUTOMATE_TEST_RUN_TIMEOUT_MS` — wall clock for one pytest run. */
  testRunTimeoutMs: number;
  /** `AUTOMATE_UV_SYNC_TIMEOUT_MS` — wall clock for preparing the Python environment. */
  uvSyncTimeoutMs: number;
  /** `AUTOMATE_FIXTURE_ROW_COUNT` — rows per synthetic fixture table. */
  fixtureRowCount: number;
  /** `AUTOMATE_MAX_SCRIPT_BYTES` — bytes per generated file. */
  maxScriptBytes: number;
}

function nonNegativeNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new ConfigurationError(`${name} must be a number of 0 or more.`);
  return value;
}

/** Parse the generation limits. @param env Environment variables to read. @returns Limits with the provisional defaults. */
export function getGenerationConfig(env = process.env): GenerationConfig {
  return {
    maxAttempts: positiveInteger(env, 'AUTOMATE_MAX_GENERATION_ATTEMPTS', MAX_GENERATION_ATTEMPTS, 20),
    timeoutMs: positiveInteger(env, 'AUTOMATE_GENERATION_TIMEOUT_MS', GENERATION_TIMEOUT_MS),
    maxCostUsd: nonNegativeNumber(env, 'AUTOMATE_MAX_GENERATION_COST_USD', MAX_GENERATION_COST_USD),
    testRunTimeoutMs: positiveInteger(env, 'AUTOMATE_TEST_RUN_TIMEOUT_MS', TEST_RUN_TIMEOUT_MS),
    uvSyncTimeoutMs: positiveInteger(env, 'AUTOMATE_UV_SYNC_TIMEOUT_MS', UV_SYNC_TIMEOUT_MS),
    fixtureRowCount: positiveInteger(env, 'AUTOMATE_FIXTURE_ROW_COUNT', FIXTURE_ROW_COUNT, 100_000),
    maxScriptBytes: positiveInteger(env, 'AUTOMATE_MAX_SCRIPT_BYTES', MAX_SCRIPT_BYTES, 16 * 1024 * 1024),
  };
}

/**
 * Verification, run, and review limits (FEAT-107, D07/D14). Every value is
 * PROVISIONAL against open D14. The verification test re-run reuses FEAT-106's
 * `AUTOMATE_TEST_RUN_TIMEOUT_MS`; the script-run timeout is the one FEAT-108
 * is most likely to replace, since it owns resource limits.
 */
export interface VerificationConfig {
  /** `AUTOMATE_VERIFICATION_TIMEOUT_MS` — wall clock across one whole verification pass. */
  verificationTimeoutMs: number;
  /** `AUTOMATE_LINT_TIMEOUT_MS` — wall clock for one ruff run. */
  lintTimeoutMs: number;
  /** `AUTOMATE_SECURITY_TIMEOUT_MS` — wall clock for one bandit run. */
  securityTimeoutMs: number;
  /** `AUTOMATE_SCRIPT_RUN_TIMEOUT_MS` — wall clock for the real-data run. */
  scriptRunTimeoutMs: number;
  /** `AUTOMATE_MAX_RUN_OUTPUT_BYTES` — bytes of stdout and of stderr kept from one real run, head and tail. */
  maxRunOutputBytes: number;
  /** `AUTOMATE_MAX_REVIEW_FEEDBACK_CHARS` — characters a person may write when rejecting a result. */
  maxReviewFeedbackChars: number;
}

/** Parse the verification limits. @param env Environment variables to read. @returns Limits with the provisional defaults. */
export function getVerificationConfig(env = process.env): VerificationConfig {
  return {
    verificationTimeoutMs: positiveInteger(env, 'AUTOMATE_VERIFICATION_TIMEOUT_MS', VERIFICATION_TIMEOUT_MS),
    lintTimeoutMs: positiveInteger(env, 'AUTOMATE_LINT_TIMEOUT_MS', LINT_TIMEOUT_MS),
    securityTimeoutMs: positiveInteger(env, 'AUTOMATE_SECURITY_TIMEOUT_MS', SECURITY_TIMEOUT_MS),
    scriptRunTimeoutMs: positiveInteger(env, 'AUTOMATE_SCRIPT_RUN_TIMEOUT_MS', SCRIPT_RUN_TIMEOUT_MS),
    maxRunOutputBytes: positiveInteger(env, 'AUTOMATE_MAX_RUN_OUTPUT_BYTES', MAX_RUN_OUTPUT_BYTES, 64 * 1024 * 1024),
    // Capped at the default: the request schema rejects longer feedback before this is read.
    maxReviewFeedbackChars: positiveInteger(env, 'AUTOMATE_MAX_REVIEW_FEEDBACK_CHARS', MAX_REVIEW_FEEDBACK_CHARS, MAX_REVIEW_FEEDBACK_CHARS),
  };
}

/** FEAT-108 preview defaults; each cap is provisional against open D14. */
export interface RuntimeConfig {
  readonly prepareOnStartup: boolean;
  readonly scriptRunTimeoutMs: number;
  readonly memoryLimitBytes: number;
  readonly maxOutputFileBytes: number;
  readonly maxOutputTotalBytes: number;
  readonly maxOutputFiles: number;
  readonly outputWatchIntervalMs: number;
  readonly prepareTimeoutMs: number;
  readonly pythonInstallTimeoutMs: number;
}

function nonNegativeInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new ConfigurationError(`${name} must be a non-negative integer.`);
  return value;
}

/** Parse the nine runtime controls with their provisional defaults. */
export function getRuntimeConfig(env = process.env): RuntimeConfig {
  const startup = env.AUTOMATE_RUNTIME_PREPARE_ON_STARTUP?.trim().toLowerCase();
  if (startup && startup !== 'true' && startup !== 'false') throw new ConfigurationError('AUTOMATE_RUNTIME_PREPARE_ON_STARTUP must be true or false.');
  return {
    prepareOnStartup: startup !== 'false',
    scriptRunTimeoutMs: positiveInteger(env, 'AUTOMATE_SCRIPT_RUN_TIMEOUT_MS', SCRIPT_RUN_TIMEOUT_MS),
    memoryLimitBytes: nonNegativeInteger(env, 'AUTOMATE_SCRIPT_MEMORY_LIMIT_BYTES', SCRIPT_MEMORY_LIMIT_BYTES),
    maxOutputFileBytes: nonNegativeInteger(env, 'AUTOMATE_SCRIPT_MAX_OUTPUT_FILE_BYTES', SCRIPT_MAX_OUTPUT_FILE_BYTES),
    maxOutputTotalBytes: nonNegativeInteger(env, 'AUTOMATE_SCRIPT_MAX_OUTPUT_TOTAL_BYTES', SCRIPT_MAX_OUTPUT_TOTAL_BYTES),
    maxOutputFiles: nonNegativeInteger(env, 'AUTOMATE_SCRIPT_MAX_OUTPUT_FILES', SCRIPT_MAX_OUTPUT_FILES),
    outputWatchIntervalMs: positiveInteger(env, 'AUTOMATE_OUTPUT_WATCH_INTERVAL_MS', OUTPUT_WATCH_INTERVAL_MS),
    prepareTimeoutMs: positiveInteger(env, 'AUTOMATE_RUNTIME_PREPARE_TIMEOUT_MS', RUNTIME_PREPARE_TIMEOUT_MS),
    pythonInstallTimeoutMs: positiveInteger(env, 'AUTOMATE_PYTHON_INSTALL_TIMEOUT_MS', PYTHON_INSTALL_TIMEOUT_MS),
  };
}
