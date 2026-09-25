import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureAppDirectories, getAppPaths, type AppPaths } from '../../config/app-paths';
import { UploadFileStore } from '../../ingestion/upload-file-store';
import { receiveUpload } from '../../ingestion/upload-intake';

let root: string;
let paths: AppPaths;
let server: Server;
let base: string;
let limit = 1024;
/** The server-side outcome of the most recent request, so a test can wait for cleanup rather than sleep. */
let outcome: Promise<unknown> = Promise.resolve();

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'automate-intake-'));
  paths = getAppPaths(root);
  ensureAppDirectories(paths);
  limit = 1024;
  const store = new UploadFileStore(paths);
  server = createServer((request, response) => {
    outcome = receiveUpload(request, { store, maxUploadBytes: limit }).then(
      (received) => response.end(JSON.stringify({ ok: true, ...received })),
      (error: { code?: string; message?: string }) => {
        response.statusCode = 400;
        response.end(JSON.stringify({ ok: false, code: error.code, message: error.message }));
      },
    );
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

type Result = { ok: boolean; code?: string; message?: string; incomingPath?: string; byteSize?: number; sha256?: string; format?: string; originalFilename?: string };

async function upload(...files: [string, Uint8Array | string][]): Promise<Result> {
  const form = new FormData();
  for (const [name, content] of files) form.append('file', new Blob([typeof content === 'string' ? content : Uint8Array.from(content)]), name);
  const response = await fetch(`${base}/upload`, { method: 'POST', body: form });
  return (await response.json()) as Result;
}

const stagedEntries = () => readdirSync(paths.stagedUploadsDir);
const sha = (content: string | Uint8Array) => createHash('sha256').update(content).digest('hex');

describe('receiveUpload', () => {
  it('streams a valid CSV to the staged area with a correct size and SHA-256', async () => {
    const content = 'id,name\n1,Zoë\n';
    const result = await upload(['données.csv', content]);
    expect(result).toMatchObject({ ok: true, format: 'csv', byteSize: Buffer.byteLength(content), sha256: sha(content), originalFilename: 'données.csv' });
    expect(path.dirname(result.incomingPath!)).toBe(paths.stagedUploadsDir);
    expect(readFileSync(result.incomingPath!, 'utf8')).toBe(content);
  });

  it('rejects a file one byte over the limit and leaves nothing on disk', async () => {
    const result = await upload(['big.csv', 'x'.repeat(limit + 1)]);
    expect(result).toMatchObject({ ok: false, code: 'UPLOAD_TOO_LARGE' });
    expect(result.message).toContain('The current limit is 1 KB');
    expect(stagedEntries()).toEqual([]);
  });

  it('refuses a request whose declared length is far over the limit before reading it, naming both sizes', async () => {
    limit = 64;
    const result = await upload(['huge.csv', 'y'.repeat(2 * 1024 * 1024)]);
    expect(result).toMatchObject({ ok: false, code: 'UPLOAD_TOO_LARGE' });
    expect(result.message).toMatch(/This file is 2 MB\. The current limit is 64 bytes\./);
    expect(stagedEntries()).toEqual([]);
  });

  it('leaves no file behind when the client disconnects mid-stream', async () => {
    const boundary = 'x-boundary';
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.csv"\r\nContent-Type: text/csv\r\n\r\nid,name\n`;
    await new Promise<void>((resolve) => {
      const request = httpRequest(`${base}/upload`, { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
      request.on('error', () => resolve());
      request.write(head);
      setTimeout(() => {
        expect(stagedEntries()).toHaveLength(1);
        request.destroy();
        resolve();
      }, 100);
    });
    for (let attempt = 0; attempt < 50 && stagedEntries().length > 0; attempt += 1) {
      await outcome;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(stagedEntries()).toEqual([]);
  });

  it('rejects two file parts', async () => {
    const result = await upload(['a.csv', 'a,b\n1,2\n'], ['b.csv', 'a,b\n1,2\n']);
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR', message: 'Attach one file per upload.' });
    expect(stagedEntries()).toEqual([]);
  });

  it('rejects a request with no file part', async () => {
    const form = new FormData();
    form.append('note', 'hello');
    const result = (await (await fetch(`${base}/upload`, { method: 'POST', body: form })).json()) as Result;
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    expect(result.message).toMatch(/No file was attached/);
  });

  it('rejects a body that is not multipart', async () => {
    const result = (await (await fetch(`${base}/upload`, { method: 'POST', body: 'plain', headers: { 'content-type': 'text/plain' } })).json()) as Result;
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
  });

  it('raises FILE_EMPTY for a zero-byte file', async () => {
    expect(await upload(['empty.csv', ''])).toMatchObject({ ok: false, code: 'FILE_EMPTY' });
    expect(stagedEntries()).toEqual([]);
  });

  it('refuses a legacy .xls with re-save guidance, and an executable', async () => {
    const xls = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    const legacy = await upload(['old.xls', xls]);
    expect(legacy).toMatchObject({ ok: false, code: 'UNSUPPORTED_FILE_FORMAT' });
    expect(legacy.message).toMatch(/Save As.*\.xlsx/);
    const exe = await upload(['setup.exe', new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0])]);
    expect(exe).toMatchObject({ ok: false, code: 'UNSUPPORTED_FILE_FORMAT' });
    expect(stagedEntries()).toEqual([]);
  });

  it('classifies a workbook by content even when it is named .csv', async () => {
    const zipHeader = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...Array(22).fill(0), 15, 0, 0, 0, ...new TextEncoder().encode('xl/workbook.xml')]);
    expect(await upload(['actually.csv', zipHeader])).toMatchObject({ ok: true, format: 'xlsx' });
  });
});
