// ---------------------------------------------------------------------------
// The code workspace (FEAT-106 TASK-006): draft → seal → project to disk.
//
// The database is authoritative for generated code. Files the agent writes
// arrive as tool arguments, are validated, and land in `code_file` rows of
// the execution's one draft. Sealing computes the version digest from those
// stored rows; projection then writes the files to
// `scripts/{executionId}/attempt-{n}/` FROM THE SAME ROWS, never from anything
// the agent handed in. The digest covers what was stored and what runs was
// written from what was digested, so "what was verified is what runs" holds
// by construction rather than by the order writes happened to occur in.
//
// Deleting `scripts/` loses nothing but time: `project` rebuilds it.
// ---------------------------------------------------------------------------

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  CodeTooLargeError,
  CodeVersionNotFoundError,
  MAX_SCRIPT_BYTES,
  ValidationError,
  utf8ByteLength,
  validateCodePath,
  type CodeFileRole,
  type CodeVersionDetail,
} from '@automate/core';
import type { Logger } from 'pino';
import { resolveWithin, type AppPaths } from '../config/app-paths';
import type { CodeFileRow, CodeVersionRepository, CodeVersionRow, CodeVersionWithFiles, FinalDetails } from '../db/repositories/code-version-repository';
import type { GenerationAttemptRepository } from '../db/repositories/generation-attempt-repository';
import { presentCodeVersionDetail } from './presenters';

export interface CodeWorkspaceDependencies {
  readonly versions: CodeVersionRepository;
  readonly attempts: GenerationAttemptRepository;
  readonly paths: AppPaths;
  readonly logger: Pick<Logger, 'info'>;
  /** `AUTOMATE_MAX_SCRIPT_BYTES`. */
  readonly maxScriptBytes?: number;
}
export interface WrittenFile { readonly file: CodeFileRow; readonly version: CodeVersionRow }

/** Owns every generated file's path from model argument to disk. */
export class CodeWorkspace {
  constructor(private readonly deps: CodeWorkspaceDependencies) {}

  /** The execution's open draft, opened at the next attempt number when none exists. */
  currentDraft(executionId: number): CodeVersionRow {
    return this.deps.versions.findDraft(executionId) ?? this.deps.versions.openDraft(executionId, this.deps.versions.nextAttemptNumber(executionId));
  }

  /**
   * Store one file in the draft, replacing a file already at that path.
   *
   * @throws InvalidCodePathError or CodeTooLargeError before anything is written — no draft is opened for a rejected file.
   */
  putFile(executionId: number, file: { readonly path: string; readonly role: CodeFileRole; readonly content: string }): WrittenFile {
    const normalized = validateCodePath(file.path, file.role);
    const limit = this.deps.maxScriptBytes ?? MAX_SCRIPT_BYTES;
    const size = utf8ByteLength(file.content);
    if (size > limit) throw new CodeTooLargeError(limit, size);
    const version = this.currentDraft(executionId);
    return { file: this.deps.versions.putFile(version.id, { ...file, path: normalized }), version };
  }

  /**
   * Seal the execution's draft and project it to disk from the stored rows.
   *
   * @returns The sealed version with its files.
   * @throws ValidationError when there is no draft or it holds no files.
   */
  seal(executionId: number): CodeVersionWithFiles {
    let draft = this.deps.versions.findDraft(executionId);
    if (!draft) throw new ValidationError('There is no new code to test. Write the script with write_script first.');
    // A refusal can have consumed this draft's number; move the draft past it before it becomes immutable.
    if (this.deps.attempts.getByNumber(executionId, draft.attempt)) draft = this.deps.versions.renumberDraft(draft.id, this.deps.versions.nextAttemptNumber(executionId));
    const sealed = this.deps.versions.seal(draft.id);
    const files = this.deps.versions.listFiles([sealed.id]);
    this.deps.logger.info({ executionId, codeVersionId: sealed.id, attempt: sealed.attempt, digest: sealed.contentDigest, fileCount: files.length, byteSize: files.reduce((sum, { byteSize }) => sum + byteSize, 0) }, 'code version sealed');
    this.project(sealed.id);
    return { ...sealed, files };
  }

  /**
   * Write a sealed version's files to its attempt directory from the database, replacing whatever is there, and create an empty `output/`.
   *
   * @returns The absolute attempt directory.
   */
  project(versionId: number): string {
    const version = this.deps.versions.getByIdWithFiles(versionId);
    if (!version) throw new CodeVersionNotFoundError(versionId);
    if (version.status === 'draft') throw new ValidationError(`Code version ${versionId} must be sealed before it is written to disk.`);
    const directory = this.attemptDir(version);
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    for (const file of version.files) {
      const target = resolveWithin(directory, ...validateCodePath(file.path, file.role as CodeFileRole).split('/'));
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file.content, 'utf8');
    }
    mkdirSync(this.outputDir(version), { recursive: true });
    return directory;
  }

  /** Mark a sealed version final with its declared contracts. */
  finalize(versionId: number, details: FinalDetails): CodeVersionRow {
    return this.deps.versions.markFinal(versionId, details);
  }

  /** A version with every file's content, for the API. */
  describe(versionId: number): CodeVersionDetail {
    const version = this.deps.versions.getByIdWithFiles(versionId);
    if (!version) throw new CodeVersionNotFoundError(versionId);
    return presentCodeVersionDetail(version, version.files);
  }

  /** The absolute attempt directory for a version, guarded against traversal. */
  attemptDir(version: Pick<CodeVersionRow, 'dirPath'>): string {
    return resolveWithin(this.deps.paths.root, ...version.dirPath.split('/'));
  }

  /** The absolute scratch output directory a test run writes into; never registered as artifacts. */
  outputDir(version: Pick<CodeVersionRow, 'dirPath'>): string {
    return resolveWithin(this.attemptDir(version), 'output');
  }
}
