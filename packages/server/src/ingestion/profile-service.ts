// ---------------------------------------------------------------------------
// Profile orchestration (FEAT-104 TASK-008): detect → read → profile → persist.
//
// Owns the parse timeout. `AbortSignal.timeout` is wired into both readers,
// which DESTROY their underlying stream when it fires — a timeout that left
// the parser running would not be a timeout. A failure marks the upload
// `failed` with a plain-English reason and keeps the stored file, so a parser
// bug never costs a person their upload.
//
// Logging: ids, counts, formats, durations, and detected dialect/encoding and
// column TYPES only. Never a filename, a cell, a sample row, a frequent value,
// or a statistic — those are the data D04 keeps bounded.
// ---------------------------------------------------------------------------

import type { Readable } from 'node:stream';
import {
  AutoMateError,
  NoTabularContentError,
  ParseFailedError,
  ParseTimeoutError,
  profileTable,
  type TableProfile,
} from '@automate/core';
import type { Logger } from 'pino';
import type { IngestionConfig } from '../config/env';
import type { UploadProfileRepository } from '../db/repositories/upload-profile-repository';
import type { UploadRepository, UploadRow } from '../db/repositories/upload-repository';
import { openCsv } from './csv-reader';
import type { UploadFileStore } from './upload-file-store';
import { openWorkbook, type XlsxSheet } from './xlsx-reader';

export interface ProfileServiceDependencies {
  readonly uploads: UploadRepository;
  readonly profiles: UploadProfileRepository;
  readonly store: UploadFileStore;
  readonly limits: IngestionConfig;
  readonly logger: Logger;
  /** Test seam: how readers open a file's byte stream. */
  readonly openStream?: (filePath: string) => Readable;
  readonly now?: () => number;
}

/** What profiling produced for one upload. */
export interface ProfileOutcome {
  readonly profiles: TableProfile[];
  readonly encoding: string | null;
}

/** A worksheet with no rows is recorded, not fatal: one junk sheet must not cost the other nineteen. */
function emptySheetProfile(sheet: XlsxSheet): TableProfile {
  const facts = sheet.describe();
  return {
    sheetName: sheet.name,
    sheetIndex: sheet.index,
    isHidden: sheet.hidden,
    rowCount: 0,
    rowCountExact: true,
    columnCount: 0,
    hasHeader: false,
    headerRowIndex: null,
    delimiter: null,
    dialect: null,
    raggedRowCount: 0,
    blankRowCount: 0,
    mergedCellCount: facts.mergedCellCount ?? 0,
    formulaCellCount: facts.formulaCellCount ?? 0,
    sampleRows: [],
    notes: [{ code: 'empty_sheet' }, ...(sheet.hidden ? [{ code: 'hidden_sheet' as const }] : [])],
    columns: [],
  };
}

/** Runs profiling for stored uploads. */
export class ProfileService {
  constructor(private readonly deps: ProfileServiceDependencies) {}

  /**
   * Profile one stored upload and persist the result.
   *
   * @param uploadId The upload to profile.
   * @returns Its table profiles.
   * @throws ParseTimeoutError, ParseFailedError, NoTabularContentError, TooManyColumnsError, WorkbookTooLargeError — after marking the upload failed.
   */
  async profile(uploadId: number): Promise<TableProfile[]> {
    const now = this.deps.now ?? (() => performance.now());
    const started = now();
    const row = this.deps.uploads.markProfiling(uploadId);
    const signal = AbortSignal.timeout(this.deps.limits.parseTimeoutMs);
    try {
      const outcome = row.format === 'xlsx' ? await this.profileWorkbook(row, signal) : await this.profileCsv(row, signal);
      const durationMs = now() - started;
      this.deps.profiles.insertProfiles(uploadId, outcome.profiles);
      this.deps.uploads.markProfiled(uploadId, { encoding: outcome.encoding, durationMs });
      this.logCompleted(row, outcome, durationMs);
      return outcome.profiles;
    } catch (cause) {
      throw this.recordFailure(row, this.classify(cause, signal), now() - started);
    }
  }

  private async profileCsv(row: UploadRow, signal: AbortSignal): Promise<ProfileOutcome> {
    const { limits } = this.deps;
    const table = await openCsv(this.deps.store.absolute(row.filePath), { maxRows: limits.maxProfileRows, signal, ...this.seam() });
    try {
      this.deps.logger.debug({ uploadId: row.id, encoding: table.encoding.encoding, delimiter: table.dialect.delimiter, hasHeader: table.dialect.hasHeader }, 'csv dialect detected');
      const profile = await profileTable(
        {
          rows: table.rows,
          header: table.header,
          headerRowIndex: table.headerRowIndex,
          expectedWidth: table.dialect.columnCount,
          leadingRowsSkipped: table.leadingRowsSkipped,
          raggedMode: 'field-count',
          describe: () => ({ truncated: table.truncated, notes: table.notes }),
        },
        { sheetName: null, sheetIndex: 0, isHidden: false, delimiter: table.dialect.delimiter, dialect: table.dialectInfo },
        { seed: row.sha256, maxRows: limits.maxProfileRows, maxColumns: limits.maxColumns, signal },
      );
      return { profiles: [profile], encoding: table.encoding.encoding };
    } finally {
      table.close();
    }
  }

  private async profileWorkbook(row: UploadRow, signal: AbortSignal): Promise<ProfileOutcome> {
    const { limits } = this.deps;
    const workbook = openWorkbook(this.deps.store.absolute(row.filePath), { maxSheets: limits.maxSheets, maxInflatedBytes: limits.maxInflatedBytes, signal, ...this.seam() });
    const profiles: TableProfile[] = [];
    try {
      for await (const sheet of workbook.sheets) profiles.push(await this.profileSheet(row, sheet, signal));
    } finally {
      workbook.close();
    }
    if (profiles.length === 0 || profiles.every((profile) => profile.columnCount === 0)) throw new NoTabularContentError();
    const ordered = profiles.sort((a, b) => a.sheetIndex - b.sheetIndex);
    ordered[0] = { ...ordered[0]!, notes: [...ordered[0]!.notes, ...workbook.facts.notes] };
    return { profiles: ordered, encoding: null };
  }

  private async profileSheet(row: UploadRow, sheet: XlsxSheet, signal: AbortSignal): Promise<TableProfile> {
    const { limits } = this.deps;
    try {
      return await profileTable(
        {
          rows: sheet.rows,
          header: sheet.header,
          headerRowIndex: sheet.headerRowIndex,
          expectedWidth: sheet.expectedWidth,
          leadingRowsSkipped: sheet.leadingRowsSkipped,
          raggedMode: 'overflow',
          describe: () => sheet.describe(),
        },
        { sheetName: sheet.name, sheetIndex: sheet.index, isHidden: sheet.hidden, delimiter: null, dialect: null },
        { seed: row.sha256, maxRows: limits.maxProfileRows, maxColumns: limits.maxColumns, signal },
      );
    } catch (cause) {
      if (!(cause instanceof NoTabularContentError)) throw cause;
      // Drain what is left of the sheet so the workbook can move on to the next one.
      for await (const _row of sheet.rows) void _row;
      return emptySheetProfile(sheet);
    }
  }

  private seam(): { openStream?: (filePath: string) => Readable } {
    return this.deps.openStream ? { openStream: this.deps.openStream } : {};
  }

  /** Map anything thrown to the typed error a person sees. Library text never escapes. */
  private classify(cause: unknown, signal: AbortSignal): AutoMateError {
    if (signal.aborted) return new ParseTimeoutError(this.deps.limits.parseTimeoutMs);
    if (cause instanceof AutoMateError) return cause;
    this.deps.logger.error({ err: cause }, 'unexpected profiling failure');
    return new ParseFailedError('Something unexpected went wrong while reading it. The file has been kept; try again, or re-save it and attach the new copy.');
  }

  private recordFailure(row: UploadRow, error: AutoMateError, durationMs: number): AutoMateError {
    this.deps.uploads.markFailed(row.id, { code: error.code, message: error.message, durationMs });
    this.deps.logger.warn({ uploadId: row.id, format: row.format, code: error.code, durationMs: Math.round(durationMs) }, 'upload profiling failed');
    return error;
  }

  private logCompleted(row: UploadRow, outcome: ProfileOutcome, durationMs: number): void {
    const { profiles } = outcome;
    this.deps.logger.info(
      {
        uploadId: row.id,
        format: row.format,
        tables: profiles.length,
        rows: profiles.reduce((sum, profile) => sum + profile.rowCount, 0),
        columns: profiles.reduce((sum, profile) => sum + profile.columnCount, 0),
        durationMs: Math.round(durationMs),
      },
      'upload profiled',
    );
    this.deps.logger.debug({ uploadId: row.id, types: profiles.map((profile) => profile.columns.map((column) => column.inferredType)) }, 'column types inferred');
  }
}
