import pino from 'pino';

/**
 * Fields that must never reach a log line.
 *
 * The agent-specific entries cover the shapes a provider SDK or a credential
 * probe could plausibly put on a logged object. Event payloads are not listed
 * because they are never logged at all: only an event's type and its execution
 * id cross into the log.
 */
const REDACTED_PATHS = [
  'req.headers.authorization', 'req.headers.cookie', 'authorization', 'cookie', '*.apiKey',
  'apiKey', 'api_key', '*.api_key', 'credential', '*.credential', 'credentials', '*.credentials',
  'accessToken', '*.accessToken', 'access_token', '*.access_token', 'refreshToken', '*.refreshToken',
  'auth.apiKey', 'auth.token', 'authStorage', 'modelRuntime',
];

/** Create a logger with secret redaction. @param level Minimum log level. @returns A Pino logger; development mode uses a pretty transport. */
export function createLogger(level = process.env.LOG_LEVEL || 'info') {
  return pino({
    level,
    redact: { paths: REDACTED_PATHS, censor: '[Redacted]' },
    ...(process.env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
  });
}
