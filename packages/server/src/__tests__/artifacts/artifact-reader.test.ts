import { afterEach, describe, expect, it } from 'vitest';
import { createWriteStream, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readTablePage, readTextPreview } from '../../artifacts/artifact-reader';
import { writeBufferedWorkbook, writeStreamingWorkbook } from '../support/workbook-fixtures';
import { startArtifactApp, type ArtifactApp } from '../support/artifact-app';

const dirs: string[] = [];
const apps: ArtifactApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function temp(name: string, content?: string | Buffer): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'automate-reader-'));
  dirs.push(dir);
  const file = path.join(dir, name);
  if (content !== undefined) writeFileSync(file, content);
  return file;
}
const LIMITS = { maxTableScanRows: 50_000, maxInflatedBytes: 1 << 30 };
const signal = () => new AbortController().signal;
const csvOf = (rows: number) => `id,name\n${Array.from({ length: rows }, (_, index) => `${index},row ${index}`).join('\n')}\n`;

describe('readTablePage (CSV)', () => {
  const file = () => temp('big.csv', csvOf(10_000));

  it('pages from the start, with the header as columns', async () => {
    const page = await readTablePage(file(), 'csv', 0, 100, LIMITS, signal());
    expect(page.columns).toEqual(['id', 'name']);
    expect(page.rows).toHaveLength(100);
    expect(page.rows[0]).toEqual(['0', 'row 0']);
    expect(page).toMatchObject({ offset: 0, limit: 100, hasMore: true, scannedRowsCapped: false, sheet: null, otherSheets: [] });
  });

  it('returns a partial last page, then an empty one', async () => {
    const f = file();
    const last = await readTablePage(f, 'csv', 9_950, 100, LIMITS, signal());
    expect(last.rows).toHaveLength(50);
    expect(last.rows[49]).toEqual(['9999', 'row 9999']);
    expect(last.hasMore).toBe(false);
    const past = await readTablePage(f, 'csv', 10_000, 100, LIMITS, signal());
    expect([past.rows.length, past.hasMore]).toEqual([0, false]);
  });

  it('reports hasMore false when the page ends exactly at the last row', async () => {
    const page = await readTablePage(temp('ten.csv', csvOf(10)), 'csv', 0, 10, LIMITS, signal());
    expect([page.rows.length, page.hasMore]).toEqual([10, false]);
  });

  it('truncates a 5,000-character cell at 200 and counts it', async () => {
    const page = await readTablePage(temp('wide.csv', `id,text\n1,${'x'.repeat(5_000)}\n2,short\n`), 'csv', 0, 10, LIMITS, signal());
    expect(page.columns).toEqual(['id', 'text']);
    expect(page.rows[0]![1]!.length).toBe(200);
    expect(page.rows[0]![1]!.endsWith('…')).toBe(true);
    expect(page.rows[1]).toEqual(['2', 'short']);
    expect(page.truncatedCellCount).toBe(1);
  });

  it('returns formula-prefixed cells verbatim and unmodified', async () => {
    const page = await readTablePage(temp('f.csv', 'a,b,c\n=SUM(A1),+1,@x\n"=cmd|\'/c calc\'!A1",-5,<script>alert(1)</script>\n'), 'csv', 0, 10, LIMITS, signal());
    expect(page.rows).toEqual([['=SUM(A1)', '+1', '@x'], ["=cmd|'/c calc'!A1", '-5', '<script>alert(1)</script>']]);
  });

  it('pages a large CSV in bounded memory: only the scanned rows are read, never the whole file', async () => {
    // 4,000 rows of ~20 KB each: an 80 MB file in which the first page is a few hundred KB.
    const big = temp('huge.csv');
    const stream = createWriteStream(big);
    stream.write('id,note\n');
    const note = 'n'.repeat(20_000);
    for (let index = 0; index < 4_000; index += 1) if (!stream.write(`${index},${note}\n`)) await once(stream, 'drain');
    stream.end();
    await once(stream, 'finish');
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().heapUsed); }, 1);
    try {
      const page = await readTablePage(big, 'csv', 0, 10, LIMITS, signal());
      expect(page.rows).toHaveLength(10);
      expect(page.hasMore).toBe(true);
      expect(page.truncatedCellCount).toBe(10);
    } finally { clearInterval(timer); }
    // Holding the 80 MB file would cost at least that much. FEAT-104's reader does stream the whole file once to
    // confirm its encoding, chunk by chunk, so the bound is "well under the file", not "the page size".
    expect(peak - before).toBeLessThan(40 * 1024 * 1024);
  }, 30_000);

  it('reports the scan cap instead of a wrong hasMore', async () => {
    const page = await readTablePage(file(), 'csv', 0, 100, { ...LIMITS, maxTableScanRows: 1_000 }, signal());
    expect(page.rows).toHaveLength(100);
    expect(page.hasMore).toBe(true);
    const deep = await readTablePage(file(), 'csv', 950, 100, { ...LIMITS, maxTableScanRows: 1_000 }, signal());
    expect(deep.rows).toHaveLength(50);
    expect(deep).toMatchObject({ hasMore: false, scannedRowsCapped: true });
  });
});

describe('readTablePage (XLSX)', () => {
  it('previews the first sheet and names the others, whichever order the workbook part comes in', async () => {
    const sheets = ['Summary', 'North', 'South', 'Notes'].map((name, index) => ({ name, rows: [['region', 'total'], [name, index * 10], ['=HYPERLINK("x")', -5]] }));
    for (const write of [writeBufferedWorkbook, writeStreamingWorkbook]) {
      const file = temp(`book-${write.name}.xlsx`);
      await write(file, sheets);
      const page = await readTablePage(file, 'xlsx', 0, 100, LIMITS, signal());
      expect(page.sheet).toBe('Summary');
      expect(page.otherSheets).toEqual(['North', 'South', 'Notes']);
      expect(page.columns).toEqual(['region', 'total']);
      expect(page.rows).toEqual([['Summary', '0'], ['=HYPERLINK("x")', '-5']]);
    }
  });

  it('pages a workbook and says when more rows follow', async () => {
    const file = temp('rows.xlsx');
    await writeBufferedWorkbook(file, [{ name: 'Data', rows: [['id', 'amount'], ...Array.from({ length: 30 }, (_, index) => [index, index * 2])] }]);
    const page = await readTablePage(file, 'xlsx', 10, 5, LIMITS, signal());
    expect(page.columns).toEqual(['id', 'amount']);
    expect(page.rows.map((row) => row[0])).toEqual(['10', '11', '12', '13', '14']);
    expect(page.hasMore).toBe(true);
  });
});

describe('readTextPreview', () => {
  it('returns a small file whole', async () => {
    expect(await readTextPreview(temp('a.json', '{"a":1}'), 100)).toEqual({ text: '{"a":1}', truncated: false, byteSize: 7, previewBytes: 7 });
  });

  it('returns the head of a 40 MB file with truncation set, in bounded memory', async () => {
    const file = temp('big.txt');
    const stream = createWriteStream(file);
    const line = `${'lorem ipsum '.repeat(8)}\n`;
    for (let written = 0; written < 40 * 1024 * 1024; written += line.length) if (!stream.write(line)) await once(stream, 'drain');
    stream.end();
    await once(stream, 'finish');
    const before = process.memoryUsage().heapUsed;
    const preview = await readTextPreview(file, 5_242_880);
    const grown = process.memoryUsage().heapUsed - before;
    expect(preview.truncated).toBe(true);
    expect(preview.previewBytes).toBe(5_242_880);
    expect(preview.byteSize).toBeGreaterThanOrEqual(40 * 1024 * 1024);
    // The head (~5 MB of bytes plus its decoded string) is the whole cost; the other 35 MB are never read.
    expect(grown).toBeLessThan(40 * 1024 * 1024);
  });

  it('decodes invalid UTF-8 with replacement rather than throwing, and drops a BOM', async () => {
    const preview = await readTextPreview(temp('bad.txt', Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0xff, 0x62])), 100);
    expect(preview.text).toBe('a�b');
  });

  it('turns a character cut at the cap into one replacement character', async () => {
    const preview = await readTextPreview(temp('cut.txt', 'aé'), 2);
    expect(preview).toMatchObject({ text: 'a�', truncated: true });
  });
});

describe('rows and preview routes', () => {
  async function start(...args: Parameters<typeof startArtifactApp>) {
    const app = await startArtifactApp(...args);
    apps.push(app);
    return app;
  }

  it('serves a page with the registrar\'s formula count', async () => {
    const app = await start({ 'f.csv': 'id,v\n1,=1\n2,+2\n3,3\n' }, [{ filename: 'f.csv', type: 'csv' }]);
    const [row] = await app.register();
    const page = await (await app.get(`/api/artifacts/${row!.id}/rows?offset=1&limit=2`)).json();
    expect(page).toMatchObject({ columns: ['id', 'v'], rows: [['2', '+2'], ['3', '3']], offset: 1, limit: 2, hasMore: false, formulaCellCount: 2 });
  });

  it.each(['limit=10000', 'limit=0', 'offset=-1', 'offset=abc', 'offset=1.5', 'page=2'])('rejects ?%s with a 400', async (query) => {
    const app = await start({ 'f.csv': 'a\n1\n' }, [{ filename: 'f.csv', type: 'csv' }]);
    const [row] = await app.register();
    const response = await app.get(`/api/artifacts/${row!.id}/rows?${query}`);
    expect(response.status).toBe(400);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('honours a lower configured page ceiling', async () => {
    const app = await start({ 'f.csv': 'a\n1\n' }, [{ filename: 'f.csv', type: 'csv' }], { maxTablePageRows: 50 });
    const [row] = await app.register();
    expect((await app.get(`/api/artifacts/${row!.id}/rows?limit=51`)).status).toBe(400);
    expect((await app.get(`/api/artifacts/${row!.id}/rows`)).status).toBe(200);
  });

  it('refuses rows for a non-table and a preview for a non-text artifact', async () => {
    const app = await start({ 'r.html': '<p>x</p>', 'i.png': Buffer.from([0x89, 0x50]) }, [{ filename: 'r.html', type: 'html' }, { filename: 'i.png', type: 'image' }]);
    const [html, image] = await app.register();
    const rows = await app.get(`/api/artifacts/${html!.id}/rows`);
    expect([rows.status, (await rows.json() as { error: { code: string } }).error.code]).toEqual([422, 'ARTIFACT_NOT_TABULAR']);
    const preview = await app.get(`/api/artifacts/${image!.id}/preview`);
    const body = await preview.json() as { error: { code: string; message: string } };
    expect([preview.status, body.error.code]).toEqual([422, 'ARTIFACT_NOT_PREVIEWABLE']);
    expect(body.error.message).toMatch(/download/i);
  });

  it('previews text with truncation, and refuses Markdown past the cap with the limit named', async () => {
    const app = await start({ 'a.txt': 'x'.repeat(2_000), 'b.md': '# '.repeat(1_000) }, [{ filename: 'a.txt', type: 'text' }, { filename: 'b.md', type: 'markdown' }], { maxPreviewBytes: 1_024 });
    const [text, markdown] = await app.register();
    expect(await (await app.get(`/api/artifacts/${text!.id}/preview`)).json()).toMatchObject({ truncated: true, previewBytes: 1_024, byteSize: 2_000 });
    const refused = await app.get(`/api/artifacts/${markdown!.id}/preview`);
    const body = await refused.json() as { error: { code: string; message: string } };
    expect([refused.status, body.error.code]).toEqual([413, 'ARTIFACT_TOO_LARGE_TO_PREVIEW']);
    expect(body.error.message).toContain('1 KB');
  });
});
