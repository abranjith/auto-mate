import { ConfigurationError } from '@automate/core';

export interface ServerConfig {
  host: string;
  port: number;
  logLevel: string;
  maxConcurrentExecutions: number;
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
    allowedOrigins,
    nodeEnv: env.NODE_ENV || 'production',
  };
}
