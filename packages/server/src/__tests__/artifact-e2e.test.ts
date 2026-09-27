// ---------------------------------------------------------------------------
// FEAT-109 end to end: a verified version is approved, the (fake) run writes
// files, the settle registers them, and the real HTTP routes serve, page, and
// archive them — asserted on stored rows, files on disk, and response headers,
// never on service return values alone. Then the hostile corpus, and the
// boundary guards as tests rather than review notes.
// ---------------------------------------------------------------------------

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { ARTIFACT_CSP, describeLimitBreach, type ArtifactListResponse } from '@automate/core';
import { createApp } from '../app';
import { getArtifactConfig } from '../config/env';
import { openDatabase } from '../db/client';
import { ArtifactRepository } from '../db/repositories/artifact-repository';
import { ExecutionRepository } from '../db/repositories/execution-repository';
import { ScriptRunRepository } from '../db/repositories/script-run-repository';
import { TaskRepository } from '../db/repositories/task-repository';
import { ArtifactService } from '../artifacts/artifact-service';
import { TaskDeletionService } from '../history/task-deletion-service';
import type { FakePythonRun } from '../execution/testing/fake-python-runner';
import type { AppPaths } from '../config/app-paths';
import type { DatabaseConnection } from '../db/client';
import { createVerificationHarness, type VerificationHarness } from './support/verification-harness';
import { writeBufferedWorkbook } from './support/workbook-fixtures';
import { readZip } from './support/zip-reader';

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'artifacts');
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
let XLSX: Buffer;
let scratch: string;
beforeAll(async () => {
  scratch = mkdtempSync(path.join(tmpdir(), 'automate-artifact-e2e-'));
  const book = path.join(scratch, 'book.xlsx');
  await writeBufferedWorkbook(book, [{ name: 'Totals', rows: [['region', 'total'], ['North', 10], ['South', 20]] }]);
  XLSX = readFileSync(book);
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const harnesses: VerificationHarness[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); }));
  await Promise.all(harnesses.splice(0).map((h) => h.dispose()));
});

/** A run that writes these files and this manifest (entries, raw text, or none), then exits with `result`. */
function writes(files: Record<string, string | Buffer>, manifest: readonly { filename: string; type: string }[] | string | null, result: FakePythonRun['result'] = { stdout: 'done', exitCode: 0, outcome: 'passed' }): FakePythonRun {
  return {
    onRun: (request) => {
      const out = request.env.AUTOMATE_OUTPUT_DIR!;
      for (const [name, content] of Object.entries(files)) writeFileSync(path.join(out, name), content);
      if (manifest !== null) writeFileSync(path.join(out, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify({ artifacts: manifest.map((entry) => ({ title: entry.filename, description: '', ...entry })) }));
    },
    result,
  };
}

/** Serve the artifact routes over a connection to the harness's database. */
async function serve(paths: AppPaths, connection: DatabaseConnection): Promise<string> {
  const config = getArtifactConfig({});
  const service = new ArtifactService({ paths, artifacts: new ArtifactRepository(connection), scriptRuns: new ScriptRunRepository(connection), executions: new ExecutionRepository(connection), tasks: new TaskRepository(connection), config, maxInflatedBytes: 1 << 30 });
  const app = createApp({ logger: pino({ level: 'silent' }), dataRoot: paths.root, version: 'test', getSchemaVersion: () => '8', paths, artifacts: { artifacts: service, root: paths.root, maxTablePageRows: config.maxTablePageRows } });
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return `http://127.0.0.1:${address.port}`;
}

/** Generate, verify, approve, run, register — with the provider guarded from the approval on. */
async function runThrough(realRun: FakePythonRun) {
  const h = await createVerificationHarness({ pythonRuns: [{}, {}, realRun], onApproved: () => undefined });
  harnesses.push(h);
  expect((await h.runToGate()).status).toBe('awaiting_approval');
  const sessionsBefore = h.provider.opened.length;
  await h.approve();
  await h.scriptRun.run(h.execution.id, new AbortController().signal);
  const base = await serve(h.store.paths, h.store.connection);
  const list = await (await fetch(`${base}/api/executions/${h.execution.id}/artifacts`)).json() as ArtifactListResponse;
  return { h, base, list, sessionsBefore };
}

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const onDisk = (h: VerificationHarness, filePath: string) => path.join(h.store.root, ...filePath.split('/'));

describe('artifacts end to end', () => {
  it('the happy path: four files written, three declared, four registered, moved, served, paged, and archived', async () => {
    const files = { 'totals.csv': 'region,total\nNorth,10\nSouth,20\n', 'chart.png': PNG, 'chart.html': fixture('plotly-inline.html'), 'book.xlsx': XLSX };
    const { h, base, list, sessionsBefore } = await runThrough(writes(files, [{ filename: 'totals.csv', type: 'csv' }, { filename: 'chart.html', type: 'plotly-html' }, { filename: 'book.xlsx', type: 'xlsx' }]));
    expect(h.repos.executions.getById(h.execution.id)?.status).toBe('awaiting_review');
    const rows = new ArtifactRepository(h.store.connection).listByExecution(h.execution.id);
    expect(rows.map((row) => [row.filename, row.declared, row.type])).toEqual([['totals.csv', true, 'csv'], ['chart.html', true, 'plotly-html'], ['book.xlsx', true, 'xlsx'], ['chart.png', false, 'image']]);
    expect(h.repos.scriptRuns.getByExecution(h.execution.id)).toMatchObject({ artifactCount: 4, unregisteredOutputCount: 0 });
    expect(readdirSync(h.store.paths.taskArtifactsDir(h.task.id)).sort()).toEqual(rows.map((row) => `${row.id}${row.extension}`).sort());
    expect(readdirSync(path.join(h.store.paths.runsDir, String(h.execution.id), 'output'))).toEqual(['manifest.json']);
    for (const row of rows) {
      expect(sha(readFileSync(onDisk(h, row.filePath)))).toBe(row.sha256);
      expect(row.sha256).toBe(sha(Buffer.from(files[row.filename as keyof typeof files])));
      const response = await fetch(`${base}/api/artifacts/${row.id}/content`);
      expect(response.headers.get('content-type')).toBe(row.mimeType);
      expect(response.headers.get('content-security-policy')).toBe(ARTIFACT_CSP);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('etag')).toBe(`"${row.sha256}"`);
      expect(sha(Buffer.from(await response.arrayBuffer()))).toBe(row.sha256);
    }
    expect(list).toMatchObject({ artifactCount: 4, discrepancies: [{ kind: 'undeclared', count: 1 }] });
    const page = await (await fetch(`${base}/api/artifacts/${rows[0]!.id}/rows`)).json();
    expect(page).toMatchObject({ columns: ['region', 'total'], rows: [['North', '10'], ['South', '20']] });
    const sheet = await (await fetch(`${base}/api/artifacts/${rows[2]!.id}/rows`)).json();
    expect(sheet).toMatchObject({ sheet: 'Totals', columns: ['region', 'total'] });
    const zip = readZip(Buffer.from(await (await fetch(`${base}/api/executions/${h.execution.id}/artifacts/archive`)).arrayBuffer()));
    expect(zip.map((entry) => [entry.name, sha(entry.data)])).toEqual(rows.map((row) => [row.filename, row.sha256]));
    const seqs = h.transcript().map((event) => event.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, index) => index + 1));
    expect(h.provider.opened.length).toBe(sessionsBefore);
  });

  it('partial: a manifest declaring three with one missing registers two and names the gap', async () => {
    const { h, list } = await runThrough(writes({ 'a.csv': 'x,y\n1,2\n', 'b.txt': 'b' }, [{ filename: 'a.csv', type: 'csv' }, { filename: 'b.txt', type: 'text' }, { filename: 'c.json', type: 'json' }]));
    expect(h.repos.executions.getById(h.execution.id)?.status).toBe('failed');
    expect(list.artifacts).toHaveLength(2);
    expect(list.discrepancies).toEqual([{ kind: 'missing', count: 1, message: 'The script said it would produce 3 files, but 1 of them was not written.' }]);
  });

  it('limit breach: the output-bytes kill settles failed, and what was written before it still registers and downloads', async () => {
    const { h, base, list } = await runThrough(writes({ 'part-1.csv': 'x,y\n1,2\n' }, null, { stdout: '', stderr: describeLimitBreach('output_bytes'), exitCode: 94, outcome: 'errored', limitBreached: 'output_bytes' }));
    expect(h.repos.scriptRuns.getByExecution(h.execution.id)).toMatchObject({ status: 'failed', limitBreached: 'output_bytes', artifactCount: 1 });
    expect(h.repos.executions.getById(h.execution.id)).toMatchObject({ status: 'failed', errorCode: 'SCRIPT_LIMIT_EXCEEDED' });
    const download = await fetch(`${base}/api/artifacts/${list.artifacts[0]!.id}/download`);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('x,y\n1,2\n');
  });

  it('retention: deleting the task removes every row and every file', async () => {
    const { h } = await runThrough(writes({ 'a.csv': 'x\n1\n', 'b.txt': 'b' }, null));
    const directory = h.store.paths.taskArtifactsDir(h.task.id);
    expect(readdirSync(directory)).toHaveLength(2);
    await h.quiesce();
    await new TaskDeletionService({ paths: h.store.paths, tasks: h.repos.tasks, executions: h.repos.executions, registry: h.registry, logger: pino({ level: 'silent' }) }).delete(h.task.id);
    for (const table of ['artifact', 'script_run', 'execution', 'task']) expect(h.store.connection.client.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toMatchObject({ n: 0 });
    expect(existsSync(directory)).toBe(false);
  });

  it('restart: a rebuilt server over the same database serves every artifact, because they are files on disk', async () => {
    const { h, list } = await runThrough(writes({ 'a.csv': 'x\n1\n', 'r.html': '<p>report</p>' }, null));
    for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
    const second = openDatabase(h.store.paths);
    try {
      const base = await serve(h.store.paths, second);
      for (const item of list.artifacts) {
        const response = await fetch(`${base}/api/artifacts/${item.id}/download`);
        expect(response.status).toBe(200);
        expect(sha(Buffer.from(await response.arrayBuffer()))).toBe(item.sha256);
      }
    } finally { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } second.close(); }
  });
});

describe('the hostile corpus', () => {
  it('contains every hostile artifact, and the application holds its line on each', async () => {
    const big = 'lorem ipsum dolor sit amet\n'.repeat(Math.ceil(40 * 1024 * 1024 / 27));
    const files: Record<string, string | Buffer> = {
      'report.html': fixture('hostile-report.html'), 'formulas.csv': fixture('formula-cells.csv'), 'plotly.html': fixture('plotly-inline.html'),
      'chart.svg': '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', 'tool.exe': 'MZ', 'big.txt': big, 'empty.txt': '',
    };
    // A manifest naming a traversal, a NUL, a CRLF, and a 500-character name is refused whole, so every file registers undeclared.
    const manifest = JSON.stringify({ artifacts: [{ filename: '../../escape.csv', type: 'csv', title: 't', description: '' }, { filename: 'a\u0000b.csv', type: 'csv', title: 't', description: '' }, { filename: 'a\r\nb.csv', type: 'csv', title: 't', description: '' }, { filename: `${'x'.repeat(500)}.csv`, type: 'csv', title: 't', description: '' }] });
    const { h, base, list } = await runThrough(writes(files, manifest));
    const byName = new Map(list.artifacts.map((item) => [item.filename, item]));
    expect([...byName.keys()].sort()).toEqual(['big.txt', 'empty.txt', 'formulas.csv', 'plotly.html', 'report.html']);
    expect(list.artifacts.every((item) => !item.declared)).toBe(true);
    expect(list.unregisteredOutputCount).toBe(2);
    expect(existsSync(path.join(h.store.root, 'escape.csv'))).toBe(false);
    const report = await fetch(`${base}/api/artifacts/${byName.get('report.html')!.id}/content`);
    expect([report.headers.get('content-type'), report.headers.get('content-security-policy'), report.headers.get('x-content-type-options')]).toEqual(['text/html; charset=utf-8', ARTIFACT_CSP, 'nosniff']);
    await report.arrayBuffer();
    expect(byName.get('formulas.csv')!.contentScan).toMatchObject({ formulaCellCount: 5, rowsAreCapped: false });
    const page = await (await fetch(`${base}/api/artifacts/${byName.get('formulas.csv')!.id}/rows`)).json() as { rows: string[][] };
    expect(page.rows[1]![2]).toBe("+cmd|'/c calc'!A1");
    const preview = await (await fetch(`${base}/api/artifacts/${byName.get('big.txt')!.id}/preview`)).json();
    expect(preview).toMatchObject({ truncated: true, previewBytes: 5_242_880 });
    const empty = await fetch(`${base}/api/artifacts/${byName.get('empty.txt')!.id}/download`);
    expect([empty.status, (await empty.arrayBuffer()).byteLength]).toEqual([200, 0]);
    expect(byName.get('plotly.html')).toMatchObject({ type: 'html', renderMode: 'sandboxed_html' });
    const zip = readZip(Buffer.from(await (await fetch(`${base}/api/executions/${h.execution.id}/artifacts/archive`)).arrayBuffer()));
    for (const entry of zip) expect(entry.name).not.toMatch(/[\\/]|\.\./);
  }, 60_000);
});

describe('boundary guards', () => {
  const SRC = path.join(import.meta.dirname, '..');
  const sources = (dir: string): string[] => readdirSync(dir).flatMap((name) => { const full = path.join(dir, name); return statSync(full).isDirectory() ? sources(full) : name.endsWith('.ts') ? [full] : []; });

  it('no artifact module reaches the agent or the prompt assembler', () => {
    for (const file of sources(path.join(SRC, 'artifacts'))) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/from ['"][^'"]*\/agent(\/|['"])/);
      expect(text, file).not.toMatch(/assemblePromptContext|pi-coding-agent/);
    }
  });

  it('nothing in the artifact path makes a network call', () => {
    for (const file of [...sources(path.join(SRC, 'artifacts')), path.join(SRC, 'routes', 'artifact-route.ts')]) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/\bfetch\(|from ['"]node:(https?|net|tls|dgram)['"]|XMLHttpRequest|WebSocket/);
    }
  });

  it('packages/core\'s artifact module imports no Node built-in and no MIME-guessing library', () => {
    const core = path.join(SRC, '..', '..', 'core', 'src', 'artifacts');
    for (const file of sources(core)) expect(readFileSync(file, 'utf8'), file).not.toMatch(/from ['"](node:|mime|file-type)/);
    for (const file of sources(path.join(SRC, 'artifacts'))) expect(readFileSync(file, 'utf8'), file).not.toMatch(/from ['"](mime|mime-types|file-type)['"]/);
  });
});
