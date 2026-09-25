// ---------------------------------------------------------------------------
// Every path FEAT-104 touches (TASK-008).
//
//   uploads/staged/incoming-<uuid>.part   — bytes still arriving (intake)
//   uploads/staged/<uploadId>/<uploadId>-<sanitized>   — before attach
//   uploads/<taskId>/<uploadId>-<sanitized>            — life of the task (D12)
//
// No path here is assembled by string concatenation. A client's filename is
// a display label: it is sanitized to a safe name AND the result still goes
// through `resolveWithin`, which must also keep it directly inside its
// directory. Sanitizing is the belt; `resolveWithin` is the braces.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { ValidationError } from '@automate/core';
import { resolveWithin, type AppPaths } from '../config/app-paths';

/** Longest sanitized filename, before the `<uploadId>-` prefix. */
export const MAX_SANITIZED_NAME = 100;
const INCOMING_PREFIX = 'incoming-';
const INCOMING_SUFFIX = '.part';

/**
 * Remove C0 control characters and DEL.
 *
 * @param text Any string.
 * @returns The string without characters below U+0020 or equal to U+007F.
 */
export function stripControlCharacters(text: string): string {
  return [...text].filter((char) => {
    const code = char.codePointAt(0)!;
    return code >= 0x20 && code !== 0x7f;
  }).join('');
}

/**
 * Derive a safe on-disk name from a client-supplied filename.
 *
 * Drops any directory part, control characters, and leading dots; folds
 * accents to plain letters; collapses everything outside `[A-Za-z0-9._-]` to
 * `-`; keeps the extension; truncates to 100 characters.
 *
 * @param original The filename exactly as the browser reported it.
 * @returns A non-empty name safe to place in a directory the application owns.
 * @example sanitizeFilename('../Données été.csv') // 'Donnees-ete.csv'
 */
export function sanitizeFilename(original: string): string {
  const base = original.split(/[\\/]/).pop() ?? '';
  const folded = base.normalize('NFKD').replace(/\p{M}/gu, '');
  const safe = stripControlCharacters(folded)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '');
  const dot = safe.lastIndexOf('.');
  const extension = dot > 0 && safe.length - dot <= 10 ? safe.slice(dot) : '';
  const stem = (extension ? safe.slice(0, dot) : safe).replace(/[.-]+$/, '') || 'upload';
  return stem.slice(0, MAX_SANITIZED_NAME - extension.length) + extension;
}

/** Store paths as forward-slash paths relative to the data root, so the root can move without rewriting rows. */
function toRelative(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join('/');
}

/** Filesystem operations for uploaded files. Rows are the repository's job. */
export class UploadFileStore {
  constructor(private readonly paths: AppPaths) {}

  /** A fresh path for bytes that are still arriving. */
  incomingPath(): string {
    return resolveWithin(this.paths.stagedUploadsDir, `${INCOMING_PREFIX}${randomUUID()}${INCOMING_SUFFIX}`);
  }

  /** The staged directory for one upload. */
  stagedDirFor(uploadId: number): string {
    return resolveWithin(this.paths.stagedUploadsDir, String(positive(uploadId)));
  }

  /**
   * The staged location of an upload's file.
   * @throws ValidationError when the name would land anywhere but directly inside the upload's directory.
   */
  stagedPathFor(uploadId: number, sanitizedName: string): string {
    return this.fileIn(this.stagedDirFor(uploadId), uploadId, sanitizedName);
  }

  /** The location of an upload's file once its task has claimed it. */
  taskPathFor(taskId: number, uploadId: number, sanitizedName: string): string {
    return this.fileIn(this.paths.uploadsDirForTask(taskId), uploadId, sanitizedName);
  }

  /** The stored name, `<uploadId>-<sanitized>`, for a client filename. */
  storedNameFor(uploadId: number, originalFilename: string): string {
    return `${positive(uploadId)}-${sanitizeFilename(originalFilename)}`;
  }

  /** A data-root-relative path for storage in the database. */
  relative(absolute: string): string {
    return toRelative(this.paths.root, resolveWithin(this.paths.uploadsDir, absolute));
  }

  /** Resolve a stored relative path back to an absolute one, refusing anything outside the uploads directory. */
  absolute(relativePath: string): string {
    return resolveWithin(this.paths.uploadsDir, resolveWithin(this.paths.root, ...relativePath.split('/')));
  }

  /** Move freshly received bytes into their staged directory. @returns The relative path now stored. */
  async placeStaged(incoming: string, uploadId: number, storedFilename: string): Promise<string> {
    const target = this.fileIn(this.stagedDirFor(uploadId), uploadId, storedFilename.slice(`${uploadId}-`.length));
    await mkdir(path.dirname(target), { recursive: true });
    await rename(resolveWithin(this.paths.stagedUploadsDir, path.basename(incoming)), target);
    return this.relative(target);
  }

  /**
   * Move a staged upload into its task's directory. Same filesystem, so the rename is atomic.
   * @returns The new relative path.
   */
  async attach(upload: { id: number; storedFilename: string; filePath: string }, taskId: number): Promise<string> {
    const target = this.fileIn(this.paths.uploadsDirForTask(taskId), upload.id, upload.storedFilename.slice(`${upload.id}-`.length));
    await mkdir(path.dirname(target), { recursive: true });
    await rename(this.absolute(upload.filePath), target);
    await rm(this.stagedDirFor(upload.id), { recursive: true, force: true });
    return this.relative(target);
  }

  /** Remove an upload's file, and its staged directory when it has one. Missing files are not an error. */
  async removeFiles(upload: { id: number; filePath: string }): Promise<void> {
    await rm(this.absolute(upload.filePath), { force: true });
    await rm(this.stagedDirFor(upload.id), { recursive: true, force: true });
  }

  /** Remove a task's whole upload directory. */
  async removeTaskDirectory(taskId: number): Promise<void> {
    await rm(this.paths.uploadsDirForTask(taskId), { recursive: true, force: true });
  }

  /** Delete a partially received file. Missing is fine. */
  async discardIncoming(incoming: string): Promise<void> {
    await rm(resolveWithin(this.paths.stagedUploadsDir, path.basename(incoming)), { force: true });
  }

  /** Everything directly under `uploads/staged/`, with its kind and age, for the orphan sweep. */
  async listStagedEntries(): Promise<{ name: string; uploadId: number | null; incoming: boolean; modifiedAt: Date }[]> {
    const entries = await readdir(this.paths.stagedUploadsDir).catch(() => []);
    return Promise.all(
      entries.map(async (name) => ({
        name,
        uploadId: /^[1-9]\d*$/.test(name) ? Number(name) : null,
        incoming: name.startsWith(INCOMING_PREFIX) && name.endsWith(INCOMING_SUFFIX),
        modifiedAt: (await stat(resolveWithin(this.paths.stagedUploadsDir, name))).mtime,
      })),
    );
  }

  /** Remove one entry under `uploads/staged/` by name. */
  async removeStagedEntry(name: string): Promise<void> {
    await rm(resolveWithin(this.paths.stagedUploadsDir, name), { recursive: true, force: true });
  }

  /** Task ids that have an upload directory. */
  async listTaskDirectories(): Promise<number[]> {
    const entries = await readdir(this.paths.uploadsDir).catch(() => []);
    return entries.filter((name) => /^[1-9]\d*$/.test(name)).map(Number);
  }

  private fileIn(directory: string, uploadId: number, sanitizedName: string): string {
    const fileName = `${positive(uploadId)}-${sanitizedName}`;
    const target = resolveWithin(directory, fileName);
    // Directly inside the directory, and named exactly as intended: no separator or dot segment survives.
    if (path.dirname(target) !== directory || path.basename(target) !== fileName) {
      throw new ValidationError('The requested path is outside the application directory.');
    }
    return target;
  }
}

function positive(id: number): number {
  if (!Number.isSafeInteger(id) || id < 1) throw new ValidationError('The upload id must be a positive integer.');
  return id;
}
