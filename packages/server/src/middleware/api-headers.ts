import type { RequestHandler } from 'express';

/** Prevent browsers from treating JSON and errors as executable content. */
export const apiHeaders: RequestHandler = (request, response, next) => {
  if (request.path.startsWith('/api')) response.setHeader('X-Content-Type-Options', 'nosniff');
  next();
};
