import { asc, eq, inArray } from 'drizzle-orm';
import {
  RepositoryError,
  type ColumnProfile,
  type ColumnStats,
  type CsvDialectInfo,
  type FileFormat,
  type InferredType,
  type ProfileNote,
  type TableProfile,
  type TopValue,
} from '@automate/core';
import type { DatabaseConnection } from '../client';
import { upload, uploadColumn, uploadProfile } from '../schema';

type ProfileRow = typeof uploadProfile.$inferSelect;
type ColumnRow = typeof uploadColumn.$inferSelect;

/** Everything the disclosure payload builder needs, read together. */
export interface DisclosureSource {
  readonly upload: {
    readonly originalFilename: string;
    readonly format: FileFormat;
    readonly byteSize: number;
    readonly sha256: string;
    readonly encoding: string | null;
  };
  readonly profiles: TableProfile[];
}

/**
 * Enforce D04 at the persistence boundary: a high-cardinality column carries
 * no distinct count and no values. Checked here as well as in the profiler, so
 * a profiler bug fails loudly instead of quietly storing free-text values.
 */
function assertCardinalityInvariant(column: ColumnProfile): void {
  if (column.isHighCardinality && (column.distinctCount !== null || column.topValues !== null)) {
    throw new RepositoryError('The file profile broke a privacy rule and was not saved.', {
      position: column.position,
      invariant: 'is_high_cardinality implies distinct_count and top_values are null',
    });
  }
}

const json = (value: unknown) => JSON.stringify(value);
const parse = <T>(text: string | null, fallback: T): T => (text === null ? fallback : (JSON.parse(text) as T));

function toColumn(row: ColumnRow): ColumnProfile {
  return {
    position: row.position,
    name: row.name,
    originalName: row.originalName,
    inferredType: row.inferredType as InferredType,
    typeConfidence: row.typeConfidence,
    isMixedType: row.isMixedType,
    nullCount: row.nullCount,
    blankCount: row.blankCount,
    valueCount: row.valueCount,
    distinctCount: row.distinctCount,
    isHighCardinality: row.isHighCardinality,
    stats: parse<ColumnStats | null>(row.stats, null),
    topValues: parse<TopValue[] | null>(row.topValues, null),
  };
}

function toProfile(row: ProfileRow, columns: ColumnProfile[]): TableProfile {
  return {
    sheetName: row.sheetName,
    sheetIndex: row.sheetIndex,
    isHidden: row.isHidden,
    rowCount: row.rowCount,
    rowCountExact: row.rowCountExact,
    columnCount: row.columnCount,
    hasHeader: row.hasHeader,
    headerRowIndex: row.headerRowIndex,
    delimiter: row.delimiter,
    dialect: parse<CsvDialectInfo | null>(row.dialect, null),
    raggedRowCount: row.raggedRowCount,
    blankRowCount: row.blankRowCount,
    mergedCellCount: row.mergedCellCount,
    formulaCellCount: row.formulaCellCount,
    sampleRows: parse<string[][]>(row.sampleRows, []),
    notes: parse<ProfileNote[]>(row.notes, []),
    columns,
  };
}

type Writer = Pick<DatabaseConnection['db'], 'insert'>;

/** Insert one profile row and its column rows through an open transaction. */
function writeProfile(tx: Writer, uploadId: number, profile: TableProfile): number {
  const { columns, sampleRows, notes, dialect, ...table } = profile;
  const created = tx
    .insert(uploadProfile)
    .values({ ...table, uploadId, dialect: dialect === null ? null : json(dialect), sampleRows: json(sampleRows), notes: json(notes) })
    .returning({ id: uploadProfile.id })
    .get();
  for (const column of columns) {
    const { stats, topValues, ...fields } = column;
    tx.insert(uploadColumn)
      .values({ ...fields, profileId: created.id, stats: stats === null ? null : json(stats), topValues: topValues === null ? null : json(topValues) })
      .run();
  }
  return created.id;
}

/** Exclusive data-access path for upload profiles and their columns (FEAT-104). */
export class UploadProfileRepository {
  constructor(private readonly connection: DatabaseConnection) {}

  /**
   * Store one table profile and all of its columns atomically.
   *
   * @param uploadId Owning upload.
   * @param profile The table profile.
   * @returns The new profile id.
   * @throws RepositoryError when a column breaks the high-cardinality invariant, or any insert fails; nothing is written.
   */
  insertProfile(uploadId: number, profile: TableProfile): number {
    return this.insertProfiles(uploadId, [profile])[0]!;
  }

  /** Store several profiles in one transaction, so a workbook is saved whole or not at all. */
  insertProfiles(uploadId: number, profiles: readonly TableProfile[]): number[] {
    profiles.forEach((profile) => profile.columns.forEach(assertCardinalityInvariant));
    try {
      return this.connection.db.transaction((tx) => profiles.map((profile) => writeProfile(tx, uploadId, profile)));
    } catch (cause) {
      throw new RepositoryError('The file profile could not be saved.', cause);
    }
  }

  /** An upload's profiles ordered by sheet, each with its columns ordered by position. */
  listByUpload(uploadId: number): TableProfile[] {
    try {
      const profiles = this.connection.db
        .select()
        .from(uploadProfile)
        .where(eq(uploadProfile.uploadId, uploadId))
        .orderBy(asc(uploadProfile.sheetIndex))
        .all();
      if (profiles.length === 0) return [];
      const columns = this.connection.db
        .select()
        .from(uploadColumn)
        .where(inArray(uploadColumn.profileId, profiles.map(({ id }) => id)))
        .orderBy(asc(uploadColumn.profileId), asc(uploadColumn.position))
        .all();
      return profiles.map((row) => toProfile(row, columns.filter(({ profileId }) => profileId === row.id).map(toColumn)));
    } catch (cause) {
      throw new RepositoryError('The file profile could not be read.', cause);
    }
  }

  /** Everything `buildDisclosurePayload` needs for one upload, or undefined when the upload does not exist. */
  getDisclosureSource(uploadId: number): DisclosureSource | undefined {
    try {
      const row = this.connection.db.select().from(upload).where(eq(upload.id, uploadId)).get();
      if (!row) return undefined;
      return {
        upload: {
          originalFilename: row.originalFilename,
          format: row.format as FileFormat,
          byteSize: row.byteSize,
          sha256: row.sha256,
          encoding: row.encoding,
        },
        profiles: this.listByUpload(uploadId),
      };
    } catch (cause) {
      if (cause instanceof RepositoryError) throw cause;
      throw new RepositoryError('The file profile could not be read.', cause);
    }
  }
}
