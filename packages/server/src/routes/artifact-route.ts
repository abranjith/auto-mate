// ---------------------------------------------------------------------------
// Artifact routes (FEAT-109 TASK-004/005/006).
//
//   GET /api/executions/:id/artifacts          the run's list, counts, discrepancies
//   GET /api/artifacts/:id                     one artifact's view
//   GET /api/artifacts/:id/content             bytes, inline
//   GET /api/artifacts/:id/download            bytes, attachment
//   GET /api/artifacts/:id/rows                one page of a CSV/XLSX
//   GET /api/artifacts/:id/preview             the head of a text/JSON/Markdown file
//   GET /api/executions/:id/artifacts/archive  every artifact, as a store-only ZIP
//
// Every path and query parameter is validated against `packages/core`'s
// TypeBox contracts; errors go to FEAT-101's envelope middleware — no handler
// formats an error body. No JSON response contains a filesystem location.
//
// The run list is UNPAGINATED on purpose: a documented exception to the
// pagination rule, because `MAX_ARTIFACTS_PER_RUN` caps it (the same exception
// FEAT-104 took for a task's uploads).
//
// All seven are read-only GETs, so FEAT-103's origin guard does not apply and
// is deliberately not added; the byte routes carry
// `Cross-Origin-Resource-Policy: same-origin`, the protection that fits them.
// Every byte-serving route sets its protective headers FIRST, so its error
// envelopes carry the CSP and `nosniff` too.
// ---------------------------------------------------------------------------

import { Value } from '@sinclair/typebox/value';
import { ArtifactIdParamsSchema, DEFAULT_TABLE_PAGE_ROWS, TablePageQuerySchema, ValidationError, buildContentDisposition } from '@automate/core';
import { Router, type NextFunction, type Request, type Response } from 'express';
import type { Logger } from 'pino';
import { toArtifactView, type ArtifactService } from '../artifacts/artifact-service';
import { serveArtifact, setProtectiveHeaders } from '../artifacts/artifact-bytes';
import { writeStoreZip } from '../artifacts/zip-writer';

export interface ArtifactRouteDependencies {
  readonly artifacts: ArtifactService;
  readonly root: string;
  /** Largest page a client may ask for; never above the schema's ceiling. */
  readonly maxTablePageRows: number;
  readonly logger: Pick<Logger, 'debug' | 'warn' | 'error'>;
}

/** Validate `:id`. @throws ValidationError for anything but a plain positive integer. */
function idOf(request: Request, what: 'artifact' | 'execution'): number {
  if (!Value.Check(ArtifactIdParamsSchema, { id: request.params.id })) throw new ValidationError(`The ${what} id must be a positive integer.`);
  return Number(request.params.id);
}

/** Validate `?offset=&limit=` after numeric conversion, against the schema and the configured ceiling. */
function pageOf(request: Request, maxRows: number): { offset: number; limit: number } {
  const raw = { ...(request.query.offset === undefined ? {} : { offset: request.query.offset }), ...(request.query.limit === undefined ? {} : { limit: request.query.limit }) };
  const numeric = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value]));
  const extra = Object.keys(request.query).filter((key) => key !== 'offset' && key !== 'limit');
  if (extra.length > 0 || !Value.Check(TablePageQuerySchema, numeric)) throw new ValidationError(`offset must be a whole number of rows from 0, and limit a whole number from 1 to ${maxRows}.`);
  const limit = (numeric.limit as number | undefined) ?? Math.min(DEFAULT_TABLE_PAGE_ROWS, maxRows);
  if (limit > maxRows) throw new ValidationError(`limit may be at most ${maxRows} rows.`);
  return { offset: (numeric.offset as number | undefined) ?? 0, limit };
}

/** Run a JSON handler, passing any error to the envelope middleware. */
function json(response: Response, next: NextFunction, action: () => unknown | Promise<unknown>): void {
  Promise.resolve().then(action).then((body) => { response.json(body); }, next);
}

/** An AbortSignal that fires when the client disconnects before the response is done. */
function clientGone(request: Request, response: Response): AbortSignal {
  const controller = new AbortController();
  response.on('close', () => { if (!response.writableFinished) controller.abort(new Error('The client disconnected.')); });
  request.on('aborted', () => controller.abort(new Error('The client disconnected.')));
  return controller.signal;
}

/** Build the seven FEAT-109 endpoints. */
export function artifactRoute(deps: ArtifactRouteDependencies): Router {
  const router = Router();
  const bytes = (disposition: 'inline' | 'attachment') => (request: Request, response: Response, next: NextFunction) => {
    setProtectiveHeaders(response);
    Promise.resolve().then(() => serveArtifact(response, deps.root, deps.artifacts.get(idOf(request, 'artifact')), { disposition, range: request.header('range'), ifNoneMatch: request.header('if-none-match') }, deps.logger)).catch(next);
  };
  router.get('/api/executions/:id/artifacts', (request, response, next) => json(response, next, () => deps.artifacts.list(idOf(request, 'execution'))));
  router.get('/api/executions/:id/artifacts/archive', (request, response, next) => {
    setProtectiveHeaders(response);
    Promise.resolve().then(async () => {
      const id = idOf(request, 'execution');
      const archive = deps.artifacts.archive(id);
      response.setHeader('Content-Type', 'application/zip');
      response.setHeader('Content-Disposition', buildContentDisposition('attachment', archive.filename));
      const signal = clientGone(request, response);
      await writeStoreZip(archive.entries, response, signal).catch((cause: unknown) => {
        if (!signal.aborted) deps.logger.error({ executionId: id, code: (cause as NodeJS.ErrnoException).code ?? 'ARCHIVE_STREAM_FAILED' }, 'archive stream failed');
        response.destroy();
      });
    }).catch(next);
  });
  router.get('/api/artifacts/:id', (request, response, next) => json(response, next, () => toArtifactView(deps.artifacts.get(idOf(request, 'artifact')))));
  router.get('/api/artifacts/:id/content', bytes('inline'));
  router.get('/api/artifacts/:id/download', bytes('attachment'));
  router.get('/api/artifacts/:id/rows', (request, response, next) => json(response, next, () => {
    const id = idOf(request, 'artifact');
    const { offset, limit } = pageOf(request, deps.maxTablePageRows);
    return deps.artifacts.tablePage(id, offset, limit, clientGone(request, response));
  }));
  router.get('/api/artifacts/:id/preview', (request, response, next) => json(response, next, () => deps.artifacts.preview(idOf(request, 'artifact'))));
  return router;
}
