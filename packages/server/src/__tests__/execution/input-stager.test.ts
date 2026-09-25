import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { InputCopyMismatchError } from '@automate/core';
import { sha256File, stageInputs } from '../../execution/input-stager';
import { createTempStore, type TempStore } from '../support/ingestion-fixtures';
import { sentinelCsv, stageProfiledUpload } from '../support/generation-fixtures';

const stores: TempStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.dispose()));

async function staged() {
  const store = createTempStore('automate-stager-');
  stores.push(store);
  const upload = await stageProfiledUpload(store.connection, store.paths, { name: 'sales.csv', bytes: Buffer.from(sentinelCsv(1_600)), format: 'csv' });
  return { store, upload, inputDir: path.join(store.paths.runsDir, '3', 'input') };
}

describe('stageInputs', () => {
  it('copies each upload under its stored name and verifies the copy', async () => {
    const { store, upload, inputDir } = await staged();
    const result = await stageInputs(store.paths, [upload], inputDir);
    const copy = path.join(inputDir, upload.storedFilename);
    expect(await sha256File(copy)).toBe(upload.sha256);
    expect(result).toEqual([{ uploadId: upload.id, storedFilename: upload.storedFilename, sha256: upload.sha256, byteSize: upload.byteSize }]);
  });
  it('raises for a copy that does not match the recorded digest, naming the file by position only', async () => {
    const { store, upload, inputDir } = await staged();
    writeFileSync(path.join(store.root, ...upload.filePath.split('/')), 'changed');
    const failure = await stageInputs(store.paths, [upload], inputDir).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InputCopyMismatchError);
    expect((failure as Error).message).toContain('file 1');
    expect((failure as Error).message).not.toContain('sales.csv');
  });
  it('recreates the input directory empty, so an earlier run leaves nothing behind', async () => {
    const { store, upload, inputDir } = await staged();
    await stageInputs(store.paths, [upload], inputDir);
    writeFileSync(path.join(inputDir, 'leftover.txt'), 'x');
    await stageInputs(store.paths, [upload], inputDir);
    expect(existsSync(path.join(inputDir, 'leftover.txt'))).toBe(false);
  });
  it('refuses an upload path outside the uploads directory', async () => {
    const { store, upload, inputDir } = await staged();
    await expect(stageInputs(store.paths, [{ ...upload, filePath: 'data/automate.db' }], inputDir)).rejects.toThrow(/outside the application directory/);
    expect(readFileSync(path.join(store.root, ...upload.filePath.split('/'))).length).toBe(upload.byteSize);
  });
});
