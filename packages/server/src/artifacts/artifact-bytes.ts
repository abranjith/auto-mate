// ---------------------------------------------------------------------------
// Serving artifact bytes (FEAT-109 TASK-004, D12).
//
// THE ONLY MODULE THAT WRITES ARTIFACT BYTES TO A RESPONSE. There is no static
// file middleware over `artifacts/`: that would give away the type, the
// disposition, and the CSP in one line of setup. Here each is code:
//
//   - `Content-Type` is the row's `mime_type`, derived by the application from
//     the type policy — never sniffed, never the model's claim;
//   - `X-Content-Type-Options: nosniff` makes that type binding, so a CSV
//     whose bytes are `<script>` is never re-read as HTML;
//   - `ARTIFACT_CSP` is sent on every response — 200, 206, 304, 416, and the
//     error envelopes — so a file opened directly in a tab is as restricted
//     as one in the sandboxed frame;
//   - `Cross-Origin-Resource-Policy: same-origin` stops another page from
//     embedding these bytes;
//   - the SHA-256 is the ETag; one `Range` is honoured, a multi-range request
//     gets the full body, and an unsatisfiable one gets 416.
//
// The type and disposition are set only once the file is known to exist, so
// an error envelope is never labelled as, say, `text/html`.
// ---------------------------------------------------------------------------

import { createReadStream, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { Response } from 'express';
import { ARTIFACT_CSP, ArtifactFileMissingError, buildContentDisposition } from '@automate/core';
import type { Logger } from 'pino';
import { resolveWithin } from '../config/app-paths';
import type { ArtifactRow } from '../db/repositories/artifact-repository';

/** The protective headers every artifact byte response carries, on every branch. */
export const PROTECTIVE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Security-Policy': ARTIFACT_CSP,
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'private, max-age=0, must-revalidate',
});

/**
 * Set the protective headers. Routes call this FIRST, before anything can
 * throw, so the error envelope carries them too.
 * @param response The Express response.
 */
export function setProtectiveHeaders(response: Response): void {
  for (const [name, value] of Object.entries(PROTECTIVE_HEADERS)) response.setHeader(name, value);
}

export interface ServeOptions {
  readonly disposition: 'inline' | 'attachment';
  /** The raw `Range` request header, if any. */
  readonly range?: string | undefined;
  /** The raw `If-None-Match` request header, if any. */
  readonly ifNoneMatch?: string | undefined;
}

/** A single satisfiable range, `full` for anything this implementation answers with the whole body, or `unsatisfiable`. */
export type RangeDecision = { readonly kind: 'full' } | { readonly kind: 'partial'; readonly start: number; readonly end: number } | { readonly kind: 'unsatisfiable' };

/**
 * Interpret a `Range` header for a file of `size` bytes.
 * @param header The raw header.
 * @param size The file's size.
 * @returns One range, the full body (absent, malformed, or multi-range), or unsatisfiable.
 */
export function decideRange(header: string | undefined, size: number): RangeDecision {
  if (!header) return { kind: 'full' };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return { kind: 'full' };
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (suffix === 0 || size === 0) return { kind: 'unsatisfiable' };
    return { kind: 'partial', start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (start >= size || end < start) return { kind: 'unsatisfiable' };
  return { kind: 'partial', start, end };
}

/** Whether `If-None-Match` names this digest (weak or strong, or `*`). */
function matchesEtag(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(',').map((part) => part.trim().replace(/^W\//, '')).some((candidate) => candidate === etag || candidate === '*');
}

/**
 * Stream one artifact to a response.
 *
 * @param response The Express response; the protective headers are (re)applied here.
 * @param root The data root the row's relative `file_path` resolves inside.
 * @param artifact The stored row.
 * @param options Disposition, and the request's `Range` and `If-None-Match`.
 * @param logger Debug logging of the served id, type, and byte count — never a name or a path.
 * @throws ArtifactFileMissingError when the row's file is gone; nothing has been written then.
 */
export async function serveArtifact(response: Response, root: string, artifact: ArtifactRow, options: ServeOptions, logger?: Pick<Logger, 'debug' | 'warn'>): Promise<void> {
  setProtectiveHeaders(response);
  const file = resolveWithin(root, ...artifact.filePath.split('/'));
  const size = statSync(file, { throwIfNoEntry: false })?.size;
  if (size === undefined) {
    logger?.warn({ artifactId: artifact.id }, 'artifact file is missing');
    throw new ArtifactFileMissingError(artifact.id);
  }
  const etag = `"${artifact.sha256}"`;
  response.setHeader('ETag', etag);
  response.setHeader('Accept-Ranges', 'bytes');
  if (matchesEtag(options.ifNoneMatch, etag)) { response.status(304).end(); return; }
  const range = decideRange(options.range, size);
  if (range.kind === 'unsatisfiable') { response.setHeader('Content-Range', `bytes */${size}`); response.status(416).end(); return; }
  response.setHeader('Content-Type', artifact.mimeType);
  response.setHeader('Content-Disposition', buildContentDisposition(options.disposition, artifact.filename));
  const start = range.kind === 'partial' ? range.start : 0;
  const end = range.kind === 'partial' ? range.end : size - 1;
  if (range.kind === 'partial') { response.status(206); response.setHeader('Content-Range', `bytes ${start}-${end}/${size}`); }
  response.setHeader('Content-Length', String(Math.max(0, end - start + 1)));
  logger?.debug({ artifactId: artifact.id, type: artifact.type, bytes: Math.max(0, end - start + 1) }, 'artifact served');
  if (size === 0) { response.end(); return; }
  await pipeline(createReadStream(file, { start, end }), response).catch((cause: unknown) => {
    // Usually the client went away mid-download; the socket is torn down either way.
    logger?.debug({ artifactId: artifact.id, code: (cause as NodeJS.ErrnoException).code ?? 'STREAM_CLOSED' }, 'artifact stream ended early');
    response.destroy();
  });
}
