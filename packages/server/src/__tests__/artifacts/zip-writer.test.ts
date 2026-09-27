import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { ArchiveTooLargeError } from '@automate/core';
import { archiveSize, planArchive, uniqueEntryNames, writeStoreZip, ZIP32_LIMIT, type ZipEntrySource } from '../../artifacts/zip-writer';
import { startArtifactApp, type ArtifactApp } from '../support/artifact-app';
import { readZip } from '../support/zip-reader';

const dirs: string[] = [];
const apps: ArtifactApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'automate-zip-'));
  dirs.push(dir);
  return dir;
}
function source(dir: string, name: string, content: string | Buffer, displayName = name): ZipEntrySource {
  const file = path.join(dir, `${dirs.length}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(file, content);
  return { name: displayName, path: file, size: Buffer.byteLength(content), modifiedAt: new Date(2026, 8, 25, 12, 30, 10) };
}
async function zipToBuffer(entries: ReturnType<typeof planArchive>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk as Buffer); done(); } });
  await writeStoreZip(entries, sink, new AbortController().signal);
  return Buffer.concat(chunks);
}

describe('store-only ZIP writer', () => {
  it('writes byte-identical entries, in order, stored, with UTF-8 names and a data descriptor', async () => {
    const dir = tempDir();
    const sources = [source(dir, 'totals.csv', 'region,total\nNorth,10\n'), source(dir, 'chart.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255])), source(dir, 'résumé.md', '# Überblick\n')];
    const entries = readZip(await zipToBuffer(planArchive(sources, ZIP32_LIMIT)));
    expect(entries.map((entry) => entry.name)).toEqual(['totals.csv', 'chart.png', 'résumé.md']);
    for (const [index, entry] of entries.entries()) {
      expect(createHash('sha256').update(entry.data).digest('hex')).toBe(createHash('sha256').update(readFileSync(sources[index]!.path)).digest('hex'));
      expect(entry.method).toBe(0);
      expect(entry.flags).toBe(0x0808);
    }
  });

  it('computes a known CRC exactly, so a checksum refactor cannot slip through', async () => {
    const dir = tempDir();
    const [entry] = planArchive([source(dir, 'a.txt', 'The quick brown fox jumps over the lazy dog')], ZIP32_LIMIT);
    const zip = await zipToBuffer([entry!]);
    // CRC-32 of the pangram, the standard check value.
    expect(zip.readUInt32LE(zip.readUInt32LE(zip.length - 6) + 16)).toBe(0x414fa339);
  });

  it('predicts its own size exactly, which is what the refusal is checked against', async () => {
    const dir = tempDir();
    const planned = planArchive([source(dir, 'a.csv', 'abc'), source(dir, 'b.csv', 'x'.repeat(1000))], ZIP32_LIMIT);
    expect((await zipToBuffer(planned)).length).toBe(archiveSize(planned));
  });

  it('writes an empty file and an empty archive correctly', async () => {
    const dir = tempDir();
    expect(readZip(await zipToBuffer(planArchive([source(dir, 'empty.txt', '')], ZIP32_LIMIT)))).toEqual([expect.objectContaining({ name: 'empty.txt', data: Buffer.alloc(0) })]);
    expect((await zipToBuffer([])).length).toBe(22);
  });

  it('deduplicates colliding names and strips anything that could escape the extraction directory', () => {
    expect(uniqueEntryNames(['report.csv', 'report.csv', 'REPORT.csv', 'notes'])).toEqual(['report.csv', 'report (2).csv', 'REPORT (3).csv', 'notes']);
    const names = uniqueEntryNames(['../../escape.csv', 'C:\\x\\evil.csv', '..', 'a\u0000b.csv', 'con.csv']);
    expect(names).toEqual(['escape.csv', 'evil.csv', 'download', 'ab.csv', '_con.csv']);
    for (const name of names) expect(name).not.toMatch(/[\\/]|\.\./);
  });

  it('writes a hostile display name as a plain entry name, as the central directory shows', async () => {
    const dir = tempDir();
    const [entry] = readZip(await zipToBuffer(planArchive([source(dir, 'x', 'a', '../../escape.csv')], ZIP32_LIMIT)));
    expect(entry!.name).toBe('escape.csv');
  });

  it('refuses an entry past 4 GiB before writing anything', () => {
    const dir = tempDir();
    const huge = { ...source(dir, 'a.bin', 'x'), size: ZIP32_LIMIT + 1 };
    expect(() => planArchive([huge], ZIP32_LIMIT)).toThrow(ArchiveTooLargeError);
    expect(() => planArchive([huge], ZIP32_LIMIT)).toThrow(/4 GB/);
  });

  it('refuses an archive past the configured ceiling', () => {
    const dir = tempDir();
    expect(() => planArchive([source(dir, 'a.bin', 'x'.repeat(100))], 50)).toThrow(ArchiveTooLargeError);
  });

  it('streams a 100 MB entry with bounded memory', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'big.bin');
    const stream = createWriteStream(file);
    const block = Buffer.alloc(1024 * 1024, 7);
    for (let index = 0; index < 100; index += 1) if (!stream.write(block)) await once(stream, 'drain');
    stream.end();
    await once(stream, 'finish');
    const planned = planArchive([{ name: 'big.bin', path: file, size: 100 * 1024 * 1024, modifiedAt: new Date() }], ZIP32_LIMIT);
    let written = 0;
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    const sink = new Writable({ highWaterMark: 64 * 1024, write(chunk, _encoding, done) { written += (chunk as Buffer).length; peak = Math.max(peak, process.memoryUsage().heapUsed); setImmediate(done); } });
    const finished = once(sink, 'finish');
    await writeStoreZip(planned, sink, new AbortController().signal);
    await finished;
    expect(written).toBe(archiveSize(planned));
    expect(peak - before).toBeLessThan(40 * 1024 * 1024);
  }, 30_000);

  it('stops, and releases the file, when the reader goes away mid-stream', async () => {
    const dir = tempDir();
    const planned = planArchive([source(dir, 'a.bin', Buffer.alloc(4 * 1024 * 1024, 1)), source(dir, 'b.bin', Buffer.alloc(1024, 2))], ZIP32_LIMIT);
    const controller = new AbortController();
    const sink = new PassThrough({ highWaterMark: 1024 });
    let received = 0;
    sink.on('data', (chunk: Buffer) => { received += chunk.length; if (received > 64 * 1024) controller.abort(new Error('client went away')); });
    await expect(writeStoreZip(planned, sink, controller.signal)).rejects.toThrow();
    // With every handle released, the temp directory can be removed on every platform.
    expect(() => rmSync(dir, { recursive: true, force: false })).not.toThrow();
    expect(received).toBeLessThan(archiveSize(planned));
  });
});

describe('archive route', () => {
  async function start(...args: Parameters<typeof startArtifactApp>) {
    const app = await startArtifactApp(...args);
    apps.push(app);
    return app;
  }

  it('streams every artifact of a run as a valid ZIP named after the task', async () => {
    const app = await start({ 'totals.csv': 'a\n1\n', 'report.html': '<p>x</p>', 'extra.txt': 'e' }, [{ filename: 'totals.csv', type: 'csv' }, { filename: 'report.html', type: 'html' }]);
    const rows = await app.register();
    const response = await app.get(`/api/executions/${app.fixture.executionId}/artifacts/archive`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-length')).toBeNull();
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="Summarize sales by month-run-${app.fixture.executionId}.zip"; filename*=UTF-8''Summarize%20sales%20by%20month-run-${app.fixture.executionId}.zip`);
    const entries = readZip(Buffer.from(await response.arrayBuffer()));
    expect(entries.map((entry) => entry.name)).toEqual(rows.map((row) => row.filename));
    for (const [index, entry] of entries.entries()) expect(createHash('sha256').update(entry.data).digest('hex')).toBe(rows[index]!.sha256);
  });

  it('answers a run with no artifacts with the envelope, not a 22-byte archive', async () => {
    const app = await start();
    const response = await app.get(`/api/executions/${app.fixture.executionId}/artifacts/archive`);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect((await response.json() as { error: { code: string; message: string } }).error.message).toBe(`Run ${app.fixture.executionId} has no output files to download.`);
  });

  it('refuses a run past the archive ceiling before sending a byte', async () => {
    const app = await start({ 'a.txt': 'x'.repeat(500) }, [{ filename: 'a.txt', type: 'text' }], { maxArchiveBytes: 100 });
    await app.register();
    const response = await app.get(`/api/executions/${app.fixture.executionId}/artifacts/archive`);
    expect(response.status).toBe(413);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('ARCHIVE_TOO_LARGE');
  });

  // The real unzip, on demand: AUTOMATE_LIVE_ZIP=1 pnpm --filter @automate/server test zip-writer
  it.skipIf(process.env.AUTOMATE_LIVE_ZIP !== '1')('passes the system unzip -t and extracts byte-identical files', async () => {
    const app = await start({ 'totals.csv': 'a\n1\n', 'totals.csv.txt': 't', 'r.html': '<p>x</p>' }, [{ filename: 'totals.csv', type: 'csv' }]);
    const rows = await app.register();
    const dir = tempDir();
    const zip = path.join(dir, 'out.zip');
    writeFileSync(zip, Buffer.from(await (await app.get(`/api/executions/${app.fixture.executionId}/artifacts/archive`)).arrayBuffer()));
    const test = spawnSync('unzip', ['-t', zip], { encoding: 'utf8' });
    expect(test.status, test.stdout + test.stderr).toBe(0);
    expect(test.stdout).toContain('No errors detected');
    const out = path.join(dir, 'x');
    expect(spawnSync('unzip', ['-q', zip, '-d', out]).status).toBe(0);
    expect(readdirSync(out).sort()).toEqual(rows.map((row) => row.filename).sort());
    for (const row of rows) expect(createHash('sha256').update(readFileSync(path.join(out, row.filename))).digest('hex')).toBe(row.sha256);
  });
});
