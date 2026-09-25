// ---------------------------------------------------------------------------
// Fixture materialization (FEAT-106 TASK-005).
//
// This service turns an execution's attached uploads into synthetic stand-in
// files under `scripts/{executionId}/fixtures/`, one per upload, each named
// with the real upload's stored filename so a script that names its input
// keeps working against the real file later.
//
// INVARIANT: it reads PROFILES, never an upload's stored bytes. It builds each
// fixture from the disclosure payload rebuilt from those profiles — the same
// bytes the person approved — and it has no reference to where an upload is
// stored. A change that resolves an upload's stored location here would let
// unverified generated code test against the person's real data.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import {
  FIXTURE_ROW_COUNT,
  FixtureGenerationError,
  buildDisclosurePayload,
  buildSyntheticFixture,
  type FileFormat,
  type TableProfile,
} from '@automate/core';
import type { Logger } from 'pino';
import { resolveWithin, type AppPaths } from '../config/app-paths';
import type { UploadProfileRepository } from '../db/repositories/upload-profile-repository';
import type { UploadRepository } from '../db/repositories/upload-repository';
import type { NewSyntheticFixture, SyntheticFixtureRepository, SyntheticFixtureRow } from '../db/repositories/synthetic-fixture-repository';
import { writeCsv, writeXlsx, type FixtureSheet } from './fixture-writer';

export interface FixtureServiceDependencies {
  readonly uploads: UploadRepository;
  readonly profiles: UploadProfileRepository;
  readonly fixtures: SyntheticFixtureRepository;
  readonly paths: AppPaths;
  readonly logger: Pick<Logger, 'info'>;
  /** `AUTOMATE_FIXTURE_ROW_COUNT`; rows per table including the approved sample rows. */
  readonly rowCount?: number;
}

/** The execution's fixtures directory, relative to the data root. Forward slashes: it is stored, not joined. */
export function fixturesDirPath(executionId: number): string {
  return `scripts/${executionId}/fixtures`;
}

/**
 * Derive a fixture's seed from the real file's digest and the execution.
 *
 * @returns 16 hex characters; the same upload in the same execution always yields the same data.
 */
export function fixtureSeed(uploadSha256: string, executionId: number): string {
  return createHash('sha256').update(`${uploadSha256}:${executionId}`).digest('hex').slice(0, 16);
}

/** Builds and records synthetic fixtures from stored profiles only. */
export class FixtureService {
  constructor(private readonly deps: FixtureServiceDependencies) {}

  /** The absolute fixtures directory handed to generated code as `AUTOMATE_INPUT_DIR`. */
  fixturesDir(executionId: number): string {
    return resolveWithin(this.deps.paths.scriptsDir, String(executionId), 'fixtures');
  }

  /**
   * Write one fixture per upload and record them, replacing any earlier set.
   *
   * @param executionId The run the fixtures belong to.
   * @param uploadIds The run's attached uploads, in the order the person attached them.
   * @param signal Cancels between files.
   * @returns The recorded fixture rows.
   * @throws FixtureGenerationError naming the file by position, never by name, when its profile is missing or failed.
   */
  async materializeFixtures(executionId: number, uploadIds: readonly number[], signal: AbortSignal): Promise<SyntheticFixtureRow[]> {
    const directory = this.fixturesDir(executionId);
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    const recorded: NewSyntheticFixture[] = [];
    for (const [index, uploadId] of uploadIds.entries()) {
      signal.throwIfAborted();
      recorded.push(await this.materializeOne(executionId, uploadId, index + 1, directory));
    }
    const rows = this.deps.fixtures.replaceForExecution(executionId, recorded);
    for (const row of rows) this.deps.logger.info({ executionId, uploadId: row.uploadId, rowCount: row.rowCount, byteSize: row.byteSize }, 'synthetic fixture materialized');
    return rows;
  }

  /**
   * Rebuild a recorded fixture's first rows for the browser — deterministically, from the disclosed profile and the recorded seed, exactly as it was written. No file is read.
   *
   * @param uploadId The upload the fixture stands in for.
   * @param seed The fixture's recorded seed.
   * @param rows How many data rows per sheet to return.
   */
  preview(uploadId: number, seed: string, rows: number): { sheetName: string | null; header: string[]; rows: string[][] }[] {
    const source = this.deps.profiles.getDisclosureSource(uploadId);
    if (!source) return [];
    const rowCount = this.deps.rowCount ?? FIXTURE_ROW_COUNT;
    return buildDisclosurePayload(source.upload, source.profiles).tables.map((table) => {
      const built = buildSyntheticFixture(table, { rowCount, seed: `${seed}:${table.sheetIndex}` });
      return { sheetName: table.sheetName, header: built.header, rows: built.rows.slice(0, rows) };
    });
  }

  private async materializeOne(executionId: number, uploadId: number, position: number, directory: string): Promise<NewSyntheticFixture> {
    const upload = this.deps.uploads.getById(uploadId);
    if (!upload || upload.profileStatus !== 'profiled') throw new FixtureGenerationError(position);
    const source = this.deps.profiles.getDisclosureSource(uploadId);
    if (!source || source.profiles.length === 0) throw new FixtureGenerationError(position, 'its analysis has no tables');
    const payload = buildDisclosurePayload(source.upload, source.profiles);
    const seed = fixtureSeed(upload.sha256, executionId);
    const rowCount = this.deps.rowCount ?? FIXTURE_ROW_COUNT;
    const sheets: FixtureSheet[] = payload.tables.map((table) => ({ sheetName: table.sheetName, isHidden: table.isHidden, hasHeader: table.hasHeader, source: table, table: buildSyntheticFixture(table, { rowCount, seed: `${seed}:${table.sheetIndex}` }) }));
    if (sheets.length === 0) throw new FixtureGenerationError(position, 'none of its tables could be described');
    const file = resolveWithin(directory, upload.storedFilename);
    const format = upload.format as FileFormat;
    if (format === 'csv') writeCsv(file, sheets[0]!, dialectOf(source.profiles[0]!), upload.encoding);
    else await writeXlsx(file, sheets);
    const bytes = readFileSync(file);
    return { uploadId, filePath: `${fixturesDirPath(executionId)}/${upload.storedFilename}`, format, sheetCount: sheets.length, rowCount, sampleRowCount: Math.min(...sheets.map(({ table }) => table.sampleRowCount)), byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), seed };
  }
}

/** The real file's CSV dialect, from its profile; comma, double quote, and `\n` when unrecorded. */
function dialectOf(profile: TableProfile) {
  return { delimiter: profile.delimiter ?? ',', quoteChar: profile.dialect?.quoteChar ?? '"', lineEnding: profile.dialect?.lineEnding ?? '\n', hasBom: profile.dialect?.hasBom ?? false };
}
