// ---------------------------------------------------------------------------
// The registrar (FEAT-109 TASK-003, D12): at run settle, every file in
// `runs/{executionId}/output/` — declared in `manifest.json` or not — becomes
// an owned artifact at `artifacts/{taskId}/{artifactId}{ext}`.
//
// Two phases:
//   1. INSPECT (async, cancellable): list the output directory without
//      following symlinks, match files to the manifest (manifest order first,
//      then undeclared files by name), resolve each type through
//      `ARTIFACT_TYPE_POLICY`, and stream each file once for its SHA-256 and
//      size, plus the formula-prefix scan for tables. Nothing moves yet, so
//      cancelling here leaves no row and no moved file.
//   2. COMMIT (synchronous, one event-loop turn): allocate ids, `fs.rename`
//      each file to its id-named path — same filesystem under one data root,
//      so atomic and free rather than a copy — and insert every row in ONE
//      transaction. If the insert fails, the moved files are put back.
//
// The model's `filename` is a display label and NEVER a path component: the
// stored path is built from the task id, the allocated id, and the policy's
// extension, through `AppPaths.artifactFile` and `resolveWithin`.
//
// Registration never decides where an execution lands. A file that cannot
// register (an extension outside its type's allowlist, a symlink, a failed
// move, the per-run cap) is COUNTED and logged, never fatal: one unrecognized
// file must not cost a person the other seven. A declared file missing from
// disk is already counted by FEAT-107's reconciliation and is not re-counted.
//
// Never logged: filenames, titles, descriptions, cell values, absolute paths.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { MANIFEST_FILENAME, mimeTypeFor, parseOutputManifest, renderModeFor, resolveArtifactType, type ArtifactType, type ContentScan, type ManifestEntry } from '@automate/core';
import type { Logger } from 'pino';
import { resolveWithin, type AppPaths } from '../config/app-paths';
import type { ArtifactRepository, ArtifactRow, NewArtifactRow } from '../db/repositories/artifact-repository';
import { scanTabularArtifact, type ScanLimits } from './artifact-scanner';

export interface ArtifactRegistrarDependencies {
  readonly paths: AppPaths;
  readonly artifacts: Pick<ArtifactRepository, 'allocateIds' | 'insertMany'>;
  readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  readonly maxArtifactsPerRun: number;
  readonly scan: ScanLimits;
}

/** The run whose outputs are registered. `manifestJson` is the verbatim text FEAT-107 stores in `script_run.manifest_json`. */
export interface RegistrationInput {
  readonly scriptRunId: number;
  readonly executionId: number;
  readonly taskId: number;
  readonly outputDir: string;
  readonly manifestJson: string | null;
}

export interface RegistrationResult {
  readonly artifacts: readonly ArtifactRow[];
  readonly undeclaredCount: number;
  readonly unregisteredOutputCount: number;
  readonly totalBytes: number;
}

/** A file ready to commit: where it is, what it is, and what streaming it found. */
interface Candidate {
  readonly source: string;
  readonly filename: string;
  readonly entry: ManifestEntry | null;
  readonly type: ArtifactType;
  readonly extension: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly contentScan: ContentScan | null;
}

/** One output-directory entry, classified without following links. */
interface Listed { readonly name: string; readonly kind: 'file' | 'link' | 'other' }

/** Stream a file once for its digest and size. */
async function digest(file: string, signal: AbortSignal): Promise<{ sha256: string; byteSize: number }> {
  const hash = createHash('sha256');
  let byteSize = 0;
  for await (const chunk of createReadStream(file, { signal })) {
    hash.update(chunk as Buffer);
    byteSize += (chunk as Buffer).length;
  }
  return { sha256: hash.digest('hex'), byteSize };
}

/** List the output directory's top level without following symlinks. */
function listOutput(outputDir: string): Listed[] {
  let entries;
  try { entries = readdirSync(outputDir, { withFileTypes: true }); } catch { return []; }
  return entries.filter(({ name }) => name !== MANIFEST_FILENAME).map(({ name }) => {
    const stat = lstatSync(path.join(outputDir, name), { throwIfNoEntry: false });
    return { name, kind: stat?.isSymbolicLink() ? 'link' : stat?.isFile() ? 'file' : 'other' };
  });
}

/** Registers a settled run's output files as artifacts. */
export class ArtifactRegistrar {
  constructor(private readonly deps: ArtifactRegistrarDependencies) {}

  /**
   * Register every output of one run.
   * @param input The run, its output directory, and its stored manifest text.
   * @param signal Cancels the inspection phase; once committing starts it runs to the end.
   * @returns The rows created and the counts to store on `script_run`.
   * @throws The abort reason when cancelled before committing (no rows, no moved files); RepositoryError when the insert fails (files moved back).
   */
  async registerRunOutputs(input: RegistrationInput, signal: AbortSignal): Promise<RegistrationResult> {
    const started = Date.now();
    const listed = listOutput(input.outputDir);
    const plan = this.plan(listed, input.manifestJson);
    let unregistered = plan.refused;
    const candidates: Candidate[] = [];
    for (const item of plan.accepted) {
      signal.throwIfAborted();
      const inspected = await this.inspect(input, item, signal);
      if (inspected) candidates.push(inspected); else unregistered += 1;
    }
    signal.throwIfAborted();
    const committed = this.commit(input, candidates);
    unregistered += committed.failedMoves;
    const result: RegistrationResult = { artifacts: committed.rows, undeclaredCount: committed.rows.filter((row) => !row.declared).length, unregisteredOutputCount: unregistered, totalBytes: committed.rows.reduce((sum, row) => sum + row.byteSize, 0) };
    this.deps.logger.info({ executionId: input.executionId, scriptRunId: input.scriptRunId, declared: plan.declaredCount, produced: listed.filter((item) => item.kind !== 'other').length, registered: result.artifacts.length, unregistered, totalBytes: result.totalBytes, durationMs: Date.now() - started }, 'artifacts registered');
    return result;
  }

  /** Order the files (manifest first, then undeclared by name), resolve types, and apply the per-run cap. */
  private plan(listed: readonly Listed[], manifestJson: string | null) {
    const manifest = manifestJson === null ? null : parseOutputManifest(manifestJson);
    const byName = new Map(listed.map((item) => [item.name, item]));
    const declared = (manifest?.artifacts ?? []).filter((entry) => byName.has(entry.filename));
    const declaredNames = new Set(declared.map((entry) => entry.filename));
    const ordered = [...declared.map((entry) => ({ item: byName.get(entry.filename)!, entry })), ...listed.filter((item) => !declaredNames.has(item.name)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((item) => ({ item, entry: null }))];
    const accepted: { name: string; entry: ManifestEntry | null; type: ArtifactType; extension: string }[] = [];
    let refused = 0;
    for (const { item, entry } of ordered) {
      if (item.kind === 'other') continue;
      const resolution = resolveArtifactType(entry?.type ?? null, item.name);
      if (item.kind === 'link' || !resolution.ok) { refused += 1; this.deps.logger.warn({ reason: item.kind === 'link' ? 'symlink' : resolution.ok ? 'unknown' : resolution.reason, declared: entry !== null }, 'output file skipped'); continue; }
      if (accepted.length >= this.deps.maxArtifactsPerRun) { refused += 1; continue; }
      accepted.push({ name: item.name, entry, type: resolution.type, extension: resolution.extension });
    }
    if (refused > 0 && accepted.length >= this.deps.maxArtifactsPerRun) this.deps.logger.warn({ limit: this.deps.maxArtifactsPerRun }, 'per-run artifact cap reached');
    return { accepted, refused, declaredCount: manifest?.artifacts.length ?? 0 };
  }

  /** Digest one file in place and, for a table, scan it. Returns null (counted unregistered) when it cannot be read. */
  private async inspect(input: RegistrationInput, item: { name: string; entry: ManifestEntry | null; type: ArtifactType; extension: string }, signal: AbortSignal): Promise<Candidate | null> {
    const source = resolveWithin(input.outputDir, item.name);
    let measured;
    try { measured = await digest(source, signal); }
    catch (cause) {
      if (signal.aborted) throw cause;
      this.deps.logger.warn({ executionId: input.executionId, reason: 'unreadable' }, 'output file skipped');
      return null;
    }
    let contentScan: ContentScan | null = null;
    if (item.type === 'csv' || item.type === 'xlsx') {
      try { contentScan = await scanTabularArtifact(source, item.type, this.deps.scan, signal); }
      catch (cause) {
        if (signal.aborted) throw cause;
        this.deps.logger.warn({ executionId: input.executionId, type: item.type }, 'formula scan skipped: the table could not be read');
      }
    }
    return { source, filename: item.name, entry: item.entry, type: item.type, extension: item.extension, ...measured, contentScan };
  }

  /** Allocate ids, move every file to its id-named path, and insert all rows at once. Synchronous on purpose. */
  private commit(input: RegistrationInput, candidates: readonly Candidate[]): { rows: ArtifactRow[]; failedMoves: number } {
    if (candidates.length === 0) return { rows: [], failedMoves: 0 };
    mkdirSync(this.deps.paths.taskArtifactsDir(input.taskId), { recursive: true });
    const ids = this.deps.artifacts.allocateIds(candidates.length);
    const moved: { row: NewArtifactRow; source: string; target: string }[] = [];
    let failedMoves = 0;
    candidates.forEach((candidate, index) => {
      const id = ids[index]!;
      const target = this.deps.paths.artifactFile(input.taskId, id, candidate.extension);
      try { renameSync(candidate.source, target); }
      catch (cause) {
        failedMoves += 1;
        this.deps.logger.warn({ executionId: input.executionId, code: (cause as NodeJS.ErrnoException).code ?? 'UNKNOWN' }, 'output file could not be moved');
        return;
      }
      moved.push({ source: candidate.source, target, row: this.toRow(input, id, candidate, statSync(target).size) });
    });
    try {
      return { rows: this.deps.artifacts.insertMany(moved.map(({ row }) => row)), failedMoves };
    } catch (cause) {
      for (const { source, target } of moved) { try { renameSync(target, source); } catch { this.deps.logger.error({ executionId: input.executionId }, 'a moved output file could not be put back'); } }
      throw cause;
    }
  }

  private toRow(input: RegistrationInput, id: number, candidate: Candidate, byteSize: number): NewArtifactRow {
    return {
      id, executionId: input.executionId, taskId: input.taskId, scriptRunId: input.scriptRunId,
      filename: candidate.filename, filePath: `artifacts/${input.taskId}/${id}${candidate.extension}`,
      type: candidate.type, extension: candidate.extension,
      mimeType: mimeTypeFor(candidate.type, candidate.extension), renderMode: renderModeFor(candidate.type, candidate.extension),
      declared: candidate.entry !== null, title: candidate.entry?.title ?? null, description: candidate.entry?.description || null,
      byteSize, sha256: candidate.sha256, contentScan: candidate.contentScan ? JSON.stringify(candidate.contentScan) : null,
    };
  }
}
