import pino from 'pino';

/** Create a logger with secret redaction. @param level Minimum log level. @returns A Pino logger; development mode uses a pretty transport. */
export function createLogger(level = process.env.LOG_LEVEL || 'info') {
  return pino({
    level,
    redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'authorization', 'cookie', '*.apiKey'], censor: '[Redacted]' },
    ...(process.env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
  });
}
