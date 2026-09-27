// ---------------------------------------------------------------------------
// Artifact read model (FEAT-109 TASK-004/005/006).
//
// Everything the artifact routes return is built here, so a route handler
// only validates input and serializes output. NO response carries a
// filesystem location: a view names its file by `filename` (a model-authored
// display label) and points at its bytes by id-based URL. `file_path` never
// leaves this module except as the input to `resolveWithin`.
//
// Nothing here opens a provider session, and no cell value, title, filename,
// or path is logged.
// ---------------------------------------------------------------------------

import { statSync } from 'node:fs';
import { ARTIFACT_TYPE_POLICY, ArtifactFileMissingError, ArtifactNotFoundError, ArtifactNotPreviewableError, ArtifactNotTabularError, ArtifactTooLargeToPreviewError, ExecutionNotFoundError, NoArtifactsError, describeDiscrepancies, parseOutputManifest, sanitizeDownloadFilename, type ArtifactListResponse, type ArtifactPreview, type ArtifactType, type ArtifactView, type ContentScan, type TablePage } from '@automate/core';
import { resolveWithin, type AppPaths } from '../config/app-paths';
import type { ArtifactConfig } from '../config/env';
import type { ArtifactRepository, ArtifactRow } from '../db/repositories/artifact-repository';
import type { ExecutionRepository } from '../db/repositories/execution-repository';
import type { ScriptRunRepository, ScriptRunRow } from '../db/repositories/script-run-repository';
import type { TaskRepository } from '../db/repositories/task-repository';
import { readTablePage, readTextPreview } from './artifact-reader';
import { planArchive, type ZipEntrySource } from './zip-writer';

export interface ArtifactServiceDependencies {
  readonly paths: AppPaths;
  readonly artifacts: Pick<ArtifactRepository, 'getById' | 'listByExecution'>;
  readonly scriptRuns: Pick<ScriptRunRepository, 'getByExecution'>;
  readonly executions: Pick<ExecutionRepository, 'getById'>;
  readonly tasks: Pick<TaskRepository, 'getById'>;
  readonly config: ArtifactConfig;
  /** FEAT-104's workbook inflation budget. */
  readonly maxInflatedBytes: number;
}

/** Map a stored row to its public view. */
export function toArtifactView(row: ArtifactRow): ArtifactView {
  return {
    id: row.id, executionId: row.executionId, taskId: row.taskId, scriptRunId: row.scriptRunId,
    filename: row.filename, type: row.type as ArtifactType, extension: row.extension, mimeType: row.mimeType,
    renderMode: row.renderMode as ArtifactView['renderMode'], declared: row.declared, title: row.title, description: row.description,
    byteSize: row.byteSize, sha256: row.sha256, contentScan: row.contentScan === null ? null : (JSON.parse(row.contentScan) as ContentScan),
    registeredAt: row.registeredAt.toISOString(),
    contentUrl: `/api/artifacts/${row.id}/content`, downloadUrl: `/api/artifacts/${row.id}/download`,
  };
}

/** Builds every artifact response. */
export class ArtifactService {
  constructor(private readonly deps: ArtifactServiceDependencies) {}

  /**
   * One stored row.
   * @throws ArtifactNotFoundError for an unknown id.
   */
  get(id: number): ArtifactRow {
    const row = this.deps.artifacts.getById(id);
    if (!row) throw new ArtifactNotFoundError(id);
    return row;
  }

  /** The absolute location of a row's bytes, for the byte routes and readers only. */
  fileOf(row: ArtifactRow): string {
    return resolveWithin(this.deps.paths.root, ...row.filePath.split('/'));
  }

  /**
   * A run's artifacts with its declared/produced/registered counts and the discrepancies in words.
   * @throws ExecutionNotFoundError for an unknown execution.
   */
  list(executionId: number): ArtifactListResponse {
    if (!this.deps.executions.getById(executionId)) throw new ExecutionNotFoundError(executionId);
    const run = this.deps.scriptRuns.getByExecution(executionId);
    const rows = this.deps.artifacts.listByExecution(executionId);
    const discrepancies = describeDiscrepancies({ declaredOutputCount: run?.declaredOutputCount ?? null, missingDeclaredCount: run ? this.missingDeclared(run, rows) : 0, undeclaredCount: rows.filter((row) => !row.declared).length, unregisteredOutputCount: run?.unregisteredOutputCount ?? null });
    return {
      executionId, scriptRunId: run?.id ?? null, artifacts: rows.map(toArtifactView),
      artifactCount: run?.artifactCount ?? null, unregisteredOutputCount: run?.unregisteredOutputCount ?? null,
      declaredOutputCount: run?.declaredOutputCount ?? null, producedOutputCount: run?.producedOutputCount ?? null,
      totalBytes: rows.reduce((sum, row) => sum + row.byteSize, 0), discrepancies,
      archiveUrl: rows.length > 0 ? `/api/executions/${executionId}/artifacts/archive` : null,
    };
  }

  /** Declared names neither registered nor still sitting in `output/` (a file that could not register stays there). */
  private missingDeclared(run: ScriptRunRow, rows: readonly ArtifactRow[]): number {
    const manifest = run.manifestJson === null ? null : parseOutputManifest(run.manifestJson);
    if (!manifest) return 0;
    const registered = new Set(rows.map((row) => row.filename));
    const output = resolveWithin(this.deps.paths.root, ...run.dirPath.split('/'), 'output');
    const stillThere = (name: string) => { try { return statSync(resolveWithin(output, name)).isFile(); } catch { return false; } };
    return manifest.artifacts.filter((entry) => !registered.has(entry.filename) && !stillThere(entry.filename)).length;
  }

  /**
   * One page of a CSV or workbook artifact, with the registrar's formula count.
   * @throws ArtifactNotTabularError for any other type; ArtifactFileMissingError when the file is gone.
   */
  async tablePage(id: number, offset: number, limit: number, signal: AbortSignal): Promise<TablePage> {
    const row = this.get(id);
    if (row.type !== 'csv' && row.type !== 'xlsx') throw new ArtifactNotTabularError(id);
    const file = this.existing(row);
    const page = await readTablePage(file, row.type, offset, limit, { maxTableScanRows: this.deps.config.maxTableScanRows, maxInflatedBytes: this.deps.maxInflatedBytes }, signal);
    const scan = row.contentScan === null ? null : (JSON.parse(row.contentScan) as ContentScan);
    return { ...page, formulaCellCount: scan?.formulaCellCount ?? null };
  }

  /**
   * The head of a text, JSON, or Markdown artifact.
   * @throws ArtifactNotPreviewableError for other types; ArtifactTooLargeToPreviewError for Markdown past the cap.
   */
  async preview(id: number): Promise<ArtifactPreview> {
    const row = this.get(id);
    if (!ARTIFACT_TYPE_POLICY[row.type as ArtifactType]?.previewable) throw new ArtifactNotPreviewableError(id);
    const file = this.existing(row);
    if (row.type === 'markdown' && row.byteSize > this.deps.config.maxPreviewBytes) throw new ArtifactTooLargeToPreviewError(this.deps.config.maxPreviewBytes);
    return readTextPreview(file, this.deps.config.maxPreviewBytes);
  }

  /**
   * Everything "Download all" needs, checked before a byte is written.
   * @returns The archive's download name and its planned entries.
   * @throws NoArtifactsError for a run with nothing to archive; ArchiveTooLargeError past the ceiling; ArtifactFileMissingError when a file is gone.
   */
  archive(executionId: number): { filename: string; entries: ReturnType<typeof planArchive> } {
    const execution = this.deps.executions.getById(executionId);
    if (!execution) throw new ExecutionNotFoundError(executionId);
    const rows = this.deps.artifacts.listByExecution(executionId);
    if (rows.length === 0) throw new NoArtifactsError(executionId);
    const sources: ZipEntrySource[] = rows.map((row) => {
      const file = this.existing(row);
      const stat = statSync(file);
      return { name: row.filename, path: file, size: stat.size, modifiedAt: stat.mtime };
    });
    const taskName = this.deps.tasks.getById(execution.taskId)?.name ?? 'task';
    const stem = sanitizeDownloadFilename(taskName).slice(0, 60).replace(/[.\s]+$/, '') || 'task';
    return { filename: `${stem}-run-${executionId}.zip`, entries: planArchive(sources, this.deps.config.maxArchiveBytes) };
  }

  private existing(row: ArtifactRow): string {
    const file = this.fileOf(row);
    if (!statSync(file, { throwIfNoEntry: false })) throw new ArtifactFileMissingError(row.id);
    return file;
  }
}
