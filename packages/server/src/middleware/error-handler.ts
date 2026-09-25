import type { ErrorRequestHandler } from 'express';
import { AutoMateError, ERROR_CODES } from '@automate/core';
import type { Logger } from 'pino';

/** Codes that mean the caller sent something wrong, not that the server broke. */
const CLIENT_ERROR_CODES: ReadonlySet<string> = new Set([
  ERROR_CODES.VALIDATION_ERROR,
  ERROR_CODES.AGENT_MODEL_NOT_FOUND,
  ERROR_CODES.AGENT_CONFIG_INVALID,
  ERROR_CODES.INVALID_STATE_TRANSITION,
  ERROR_CODES.UPLOAD_LIMIT_REACHED,
  ERROR_CODES.FILE_EMPTY,
  ERROR_CODES.CLARIFICATION_INVALID_ANSWER,
]);

/** Ingestion outcomes with a more specific status than "bad request" (FEAT-104). */
const INGESTION_STATUS: Readonly<Record<string, number>> = {
  [ERROR_CODES.UPLOAD_NOT_FOUND]: 404,
  [ERROR_CODES.UPLOAD_ALREADY_ATTACHED]: 409,
  [ERROR_CODES.UPLOAD_TOO_LARGE]: 413,
  [ERROR_CODES.UNSUPPORTED_FILE_FORMAT]: 415,
  // The file arrived intact but could not be understood as a table.
  [ERROR_CODES.PARSE_FAILED]: 422,
  [ERROR_CODES.PARSE_TIMEOUT]: 422,
  [ERROR_CODES.TOO_MANY_COLUMNS]: 422,
  [ERROR_CODES.WORKBOOK_TOO_LARGE]: 422,
  [ERROR_CODES.NO_TABULAR_CONTENT]: 422,
};

/** Format safe error envelopes. @param logger Fallback logger. @returns Express error middleware that sends a correlation ID. */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, _request, response, _next) => {
    const correlationId = String(response.locals.correlationId);
    const known = error instanceof AutoMateError;
    const code = known ? error.code : ERROR_CODES.INTERNAL_ERROR;
    const message = known
      ? error.message
      : 'An unexpected server error occurred.';
    const notFound =
      code === ERROR_CODES.NOT_FOUND ||
      code === ERROR_CODES.TASK_NOT_FOUND ||
      code === ERROR_CODES.EXECUTION_NOT_FOUND ||
      code === ERROR_CODES.CLARIFICATION_NOT_FOUND;
    const conflict =
      code === ERROR_CODES.EXECUTION_NOT_RUNNING ||
      code === ERROR_CODES.EXECUTION_INTERRUPTED ||
      code === ERROR_CODES.EXECUTION_LIMIT_REACHED ||
      code === ERROR_CODES.DISCLOSURE_CONSENT_REQUIRED ||
      code === ERROR_CODES.DISCLOSURE_CONSENT_STALE ||
      code === ERROR_CODES.DISCLOSURE_SCOPE_NOT_GRANTED ||
      code === ERROR_CODES.PREFLIGHT_DECISION_REQUIRED ||
      code === ERROR_CODES.CLARIFICATION_NOT_PENDING ||
      code === ERROR_CODES.CLARIFICATION_LIMIT_REACHED ||
      code === ERROR_CODES.WAITING_CAPACITY_REACHED;
    const status = INGESTION_STATUS[code] ?? (CLIENT_ERROR_CODES.has(code)
      ? 400
      : notFound
        ? 404
        : code === ERROR_CODES.ORIGIN_REJECTED
          ? 403
          : conflict
            ? 409
            : 500);
    if (status >= 500)
      (response.locals.log ?? logger).error(
        { err: error, correlationId },
        'request failed',
      );
    else
      (response.locals.log ?? logger).info(
        { code, status, correlationId },
        'request rejected',
      );
    response.status(status).json({ error: { code, message, correlationId } });
  };
}
