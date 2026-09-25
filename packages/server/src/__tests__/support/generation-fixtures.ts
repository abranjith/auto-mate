// Shared test support for the generation suites. Not a test file: suites
// import it, so it must not register `describe` blocks of its own.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { UPLOAD_LIMIT_DEFAULTS } from '@automate/core';
import type { AppPaths } from '../../config/app-paths';
import type { DatabaseConnection } from '../../db/client';
import { UploadProfileRepository } from '../../db/repositories/upload-profile-repository';
import { UploadRepository, type UploadRow } from '../../db/repositories/upload-repository';
import { ProfileService, UploadFileStore } from '../../ingestion/index';

/** Sentinels that exist only outside what the disclosure may carry. */
export const ROW_11_SENTINEL = 'QZX-ROW-ELEVEN-7f3a91';
export const HIGH_CARDINALITY_SENTINEL = 'QZX-HIGHCARD-b04e2c';
export const TRACEBACK_SENTINEL = 'QZX-TRACEBACK-5d6e7f';

/**
 * A CSV whose row 11 and whose 1,500-distinct-value column hold unique sentinels.
 * Both sit in the high-cardinality `ref` column: a low-cardinality column would
 * legitimately disclose a rare value among its frequent values, which is not a leak.
 *
 * @param rows Data rows after the header; at least 1,500 so `ref` is high-cardinality.
 * @returns The file text.
 */
export function sentinelCsv(rows = 1_600): string {
  const lines = ['order_id,region,amount,ref'];
  for (let index = 1; index <= rows; index += 1) {
    const region = ['North', 'South', 'East', 'West'][index % 4];
    const ref = index === 11 ? ROW_11_SENTINEL : index === 1_234 ? HIGH_CARDINALITY_SENTINEL : `ref-${(index * 7919) % 100_000}`;
    lines.push(`${1000 + index},${region},${(index % 97) + 0.5},${ref}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Stage a real file exactly as FEAT-104 would and profile it with the real profiler.
 *
 * @param connection Migrated database.
 * @param paths Temporary data root.
 * @param file The original filename and bytes.
 * @returns The profiled upload row.
 */
export async function stageProfiledUpload(connection: DatabaseConnection, paths: AppPaths, file: { readonly name: string; readonly bytes: Buffer; readonly format: 'csv' | 'xlsx' }): Promise<UploadRow> {
  const uploads = new UploadRepository(connection);
  const profiles = new UploadProfileRepository(connection);
  const store = new UploadFileStore(paths);
  const facts = { originalFilename: file.name, format: file.format, mimeType: file.format === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', byteSize: file.bytes.length, sha256: createHash('sha256').update(file.bytes).digest('hex') };
  const row = uploads.stage(facts, (id) => {
    const storedFilename = store.storedNameFor(id, file.name);
    return { storedFilename, filePath: store.relative(store.stagedPathFor(id, storedFilename.slice(`${id}-`.length))) };
  });
  const absolute = store.absolute(row.filePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, file.bytes);
  await new ProfileService({ uploads, profiles, store, limits: { ...UPLOAD_LIMIT_DEFAULTS }, logger: pino({ level: 'silent' }) }).profile(row.id);
  return uploads.getById(row.id)!;
}
