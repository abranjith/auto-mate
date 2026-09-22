import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Logger } from 'pino';

/** Attach request context. @param logger Parent Pino logger. @returns Middleware that sets the response header and a child logger. */
export function correlationId(logger: Logger): RequestHandler {
  return (request, response, next) => {
    const incoming = request.header('x-correlation-id');
    const id = incoming && incoming.length <= 128 ? incoming : randomUUID();
    response.setHeader('x-correlation-id', id);
    response.locals.correlationId = id;
    response.locals.log = logger.child({ correlationId: id });
    response.locals.log.debug({ method: request.method, url: request.path }, 'request received');
    next();
  };
}
