import type { ErrorRequestHandler } from 'express';
import { AutoMateError, ERROR_CODES } from '@automate/core';
import type { Logger } from 'pino';

/** Codes that mean the caller sent something wrong, not that the server broke. */
const CLIENT_ERROR_CODES: ReadonlySet<string> = new Set([
  ERROR_CODES.VALIDATION_ERROR,
  ERROR_CODES.AGENT_MODEL_NOT_FOUND,
  ERROR_CODES.AGENT_CONFIG_INVALID,
]);

/** Format safe error envelopes. @param logger Fallback logger. @returns Express error middleware that sends a correlation ID. */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, _request, response, _next) => {
    const correlationId = String(response.locals.correlationId);
    const known = error instanceof AutoMateError;
    const code = known ? error.code : ERROR_CODES.INTERNAL_ERROR;
    const message = known ? error.message : 'An unexpected server error occurred.';
    const status = CLIENT_ERROR_CODES.has(code) ? 400 : code === ERROR_CODES.NOT_FOUND ? 404 : 500;
    if (status >= 500) (response.locals.log ?? logger).error({ err: error, correlationId }, 'request failed');
    else (response.locals.log ?? logger).info({ code, status, correlationId }, 'request rejected');
    response.status(status).json({ error: { code, message, correlationId } });
  };
}
