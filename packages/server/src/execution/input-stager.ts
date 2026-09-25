// ---------------------------------------------------------------------------
// Input staging (FEAT-107 TASK-011): the first code path that opens an
// upload's stored bytes — to COPY them, after a person authorized the run,
// never to build a prompt.
//
// Each attached upload is copied to `runs/{executionId}/input/<stored name>`
// and the COPY is re-digested against `upload.sha256`: a copy nobody verified
// is a claim, not a guard. The script is then handed the copy, so the
// original is not the file it opens.
//
// This guards against a BUGGY script. It is NOT a security boundary: nothing
// in this preview prevents generated code from reaching the original, or any
// other file on this computer (D03).
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { InputCopyMismatchError } from '@automate/core';
import { resolveWithin, type AppPaths } from '../config/app-paths';
import type { UploadRow } from '../db/repositories/upload-repository';
import type { StagedInput } from '../db/repositories/script-run-repository';

/** Stream a file through SHA-256. @returns The lowercase hex digest. */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Copy every upload into a fresh input directory and verify each copy.
 * @param paths Application paths; uploads resolve under the data root's uploads directory only.
 * @param uploads The execution's attached uploads, in attachment order.
 * @param inputDir `runs/{executionId}/input`, recreated empty.
 * @returns Exactly which bytes were staged, by digest.
 * @throws InputCopyMismatchError naming the file by position, never by name, when a copy's digest differs.
 */
export async function stageInputs(paths: AppPaths, uploads: readonly UploadRow[], inputDir: string): Promise<StagedInput[]> {
  await rm(inputDir, { recursive: true, force: true });
  await mkdir(inputDir, { recursive: true });
  const staged: StagedInput[] = [];
  for (const [index, upload] of uploads.entries()) {
    const source = resolveWithin(paths.uploadsDir, resolveWithin(paths.root, ...upload.filePath.split('/')));
    const target = resolveWithin(inputDir, upload.storedFilename);
    await copyFile(source, target);
    const digest = await sha256File(target);
    if (digest !== upload.sha256) throw new InputCopyMismatchError(index + 1);
    staged.push({ uploadId: upload.id, storedFilename: upload.storedFilename, sha256: digest, byteSize: upload.byteSize });
  }
  return staged;
}
