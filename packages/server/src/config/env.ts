import { ConfigurationError } from '@automate/core';

/** Parse server settings. @param env Environment variables to read. @returns Host, port, and log level. @throws ConfigurationError for an invalid port. */
export function getServerConfig(env = process.env): { host: string; port: number; logLevel: string } {
  const port = Number(env.AUTOMATE_PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigurationError('AUTOMATE_PORT must be a valid TCP port.');
  return { host: env.AUTOMATE_HOST || '127.0.0.1', port, logLevel: env.LOG_LEVEL || 'info' };
}
