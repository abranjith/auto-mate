import { AutoMateError, ERROR_CODES } from '@automate/core';
import type { RequestHandler } from 'express';
import type { ServerConfig } from '../config/env';

export type OriginConfig = Pick<
  ServerConfig,
  'host' | 'port' | 'allowedOrigins' | 'nodeEnv'
>;
function allowed(config: OriginConfig): Set<string> {
  const values = new Set(config.allowedOrigins);
  values.add(`http://${config.host}:${config.port}`);
  values.add(`http://127.0.0.1:${config.port}`);
  values.add(`http://localhost:${config.port}`);
  if (config.nodeEnv === 'development') {
    values.add('http://127.0.0.1:5173');
    values.add('http://localhost:5173');
  }
  return values;
}
export function isAllowedOrigin(
  origin: string | undefined,
  config: OriginConfig,
): boolean {
  if (origin === undefined) return true;
  if (origin === 'null') return false;
  return allowed(config).has(origin);
}
export function isAllowedHost(
  host: string | undefined,
  config: OriginConfig,
): boolean {
  if (!host) return false;
  const normalized = host.toLowerCase();
  return (
    normalized === `${config.host}:${config.port}`.toLowerCase() ||
    normalized === `127.0.0.1:${config.port}` ||
    normalized === `localhost:${config.port}`
  );
}
/** Reject browser state changes from foreign pages before a route mutates data. */
export function originGuard(config: OriginConfig): RequestHandler {
  return (request, _response, next) =>
    isAllowedOrigin(request.header('origin'), config) &&
    isAllowedHost(request.header('host'), config)
      ? next()
      : next(
          new AutoMateError(
            ERROR_CODES.ORIGIN_REJECTED,
            'This request did not come from the local Auto-Mate application.',
          ),
        );
}
