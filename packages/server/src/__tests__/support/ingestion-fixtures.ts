// Shared test support for the ingestion suites. Not a test file: suites import
// it, so it must not register `describe` blocks of its own.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ColumnProfile, TableProfile } from '@automate/core';
import { ensureAppDirectories, getAppPaths, type AppPaths } from '../../config/app-paths';
import { openDatabase, type DatabaseConnection } from '../../db/client';
import { migrateDatabase } from '../../db/migrate';

export const SHA = 'c'.repeat(64);

/** A migrated database under a fresh temporary data root; never the developer's real ~/.automate. */
export interface TempStore {
  readonly root: string;
  readonly paths: AppPaths;
  readonly connection: DatabaseConnection;
  dispose(): void;
}

/** Create a temporary, migrated data root. Call `dispose()` in `afterEach`. */
export function createTempStore(prefix = 'automate-ingest-'): TempStore {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const paths = getAppPaths(root);
  ensureAppDirectories(paths);
  const connection = openDatabase(paths);
  migrateDatabase(connection);
  return {
    root,
    paths,
    connection,
    dispose() {
      connection.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A representative column profile. */
export function columnProfile(overrides: Partial<ColumnProfile> = {}): ColumnProfile {
  return {
    position: 0,
    name: 'amount',
    originalName: null,
    inferredType: 'integer',
    typeConfidence: 1,
    isMixedType: false,
    nullCount: 0,
    blankCount: 0,
    valueCount: 2,
    distinctCount: 2,
    isHighCardinality: false,
    stats: { kind: 'numeric', min: 1, max: 2, mean: 1.5, stddev: 0.7071067811865476, median: 1.5, p25: 1.25, p75: 1.75, approximate: false },
    topValues: [
      { value: '1', count: 1 },
      { value: '2', count: 1 },
    ],
    ...overrides,
  };
}

/** A representative CSV table profile with `columns` integer columns. */
export function tableProfile(overrides: Partial<TableProfile> = {}, columns = 1): TableProfile {
  return {
    sheetName: null,
    sheetIndex: 0,
    isHidden: false,
    rowCount: 2,
    rowCountExact: true,
    columnCount: columns,
    hasHeader: true,
    headerRowIndex: 0,
    delimiter: ',',
    dialect: { quoteChar: '"', lineEnding: '\n', hasBom: false, confidence: { delimiter: 1, quoteChar: 0.5, lineEnding: 1, header: 1 } },
    raggedRowCount: 0,
    blankRowCount: 0,
    mergedCellCount: 0,
    formulaCellCount: 0,
    sampleRows: [Array(columns).fill('1'), Array(columns).fill('2')],
    notes: [{ code: 'blank_rows', count: 1 }],
    columns: Array.from({ length: columns }, (_, position) => columnProfile({ position, name: `col_${position}` })),
    ...overrides,
  };
}
