import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import pino from 'pino';
import { ARTIFACT_TYPE_POLICY, RepositoryError, type ArtifactType } from '@automate/core';
import { resolveWithin } from '../../config/app-paths';
import { ArtifactRegistrar, type RegistrationInput } from '../../artifacts/artifact-registrar';
import { ArtifactRepository } from '../../db/repositories/artifact-repository';
import { createRunFixture, writeManifest, writeOutput, type RunFixture } from '../support/artifact-fixtures';

const fixtures: RunFixture[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.store.dispose()));

/** A logger whose every line is captured, so tests can assert what is never logged. */
function capturingLogger() {
  const lines: string[] = [];
  const logger = pino({ level: 'debug' }, new Writable({ write(chunk, _encoding, done) { lines.push(String(chunk)); done(); } }));
  return { logger, lines };
}

function setup(options: { maxArtifactsPerRun?: number; formulaScanRows?: number; artifacts?: Pick<ArtifactRepository, 'allocateIds' | 'insertMany'> } = {}) {
  const fixture = createRunFixture();
  fixtures.push(fixture);
  const { logger, lines } = capturingLogger();
  const registrar = new ArtifactRegistrar({ paths: fixture.store.paths, artifacts: options.artifacts ?? fixture.artifacts, logger, maxArtifactsPerRun: options.maxArtifactsPerRun ?? 200, scan: { formulaScanRows: options.formulaScanRows ?? 5_000, maxInflatedBytes: 1 << 30 } });
  const input = (): RegistrationInput => {
    const manifest = path.join(fixture.outputDir, 'manifest.json');
    return { scriptRunId: fixture.run.id, executionId: fixture.executionId, taskId: fixture.taskId, outputDir: fixture.outputDir, manifestJson: existsSync(manifest) ? readFileSync(manifest, 'utf8') : null };
  };
  const register = (signal = new AbortController().signal) => registrar.registerRunOutputs(input(), signal);
  return { fixture, registrar, register, lines, logger };
}

const sha = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
const artifactFiles = (f: RunFixture) => { try { return readdirSync(f.store.paths.taskArtifactsDir(f.taskId)).sort(); } catch { return []; } };
const outputFiles = (f: RunFixture) => readdirSync(f.outputDir).sort();

describe('ArtifactRegistrar', () => {
  it('moves three declared files into artifacts/{taskId}/, digests them, and records them declared', async () => {
    const s = setup();
    const contents: Record<string, string> = { 'totals.csv': 'region,total\nNorth,10\n', 'notes.md': '# Notes\n', 'data.json': '{"a":1}' };
    for (const [name, content] of Object.entries(contents)) writeOutput(s.fixture, name, content);
    writeManifest(s.fixture, [{ filename: 'totals.csv', type: 'csv', title: 'Totals', description: 'By region' }, { filename: 'notes.md', type: 'markdown' }, { filename: 'data.json', type: 'json' }]);
    const result = await s.register();
    expect(result).toMatchObject({ undeclaredCount: 0, unregisteredOutputCount: 0 });
    expect(result.artifacts.map((row) => row.filename)).toEqual(['totals.csv', 'notes.md', 'data.json']);
    expect(outputFiles(s.fixture)).toEqual(['manifest.json']);
    for (const row of result.artifacts) {
      expect(row.declared).toBe(true);
      expect(row.filePath).toBe(`artifacts/${s.fixture.taskId}/${row.id}${row.extension}`);
      const onDisk = readFileSync(resolveWithin(s.fixture.store.root, ...row.filePath.split('/')));
      expect(row.sha256).toBe(sha(onDisk));
      expect(row.sha256).toBe(sha(contents[row.filename]!));
      expect(row.byteSize).toBe(Buffer.byteLength(contents[row.filename]!));
      expect(row.renderMode).toBe(ARTIFACT_TYPE_POLICY[row.type as ArtifactType].renderMode);
      expect(ARTIFACT_TYPE_POLICY[row.type as ArtifactType].mimeTypes[row.extension]).toBe(row.mimeType);
    }
    expect(result.artifacts[0]).toMatchObject({ title: 'Totals', description: 'By region', type: 'csv', mimeType: 'text/csv; charset=utf-8' });
    expect(result.totalBytes).toBe(Object.values(contents).reduce((sum, content) => sum + Buffer.byteLength(content), 0));
    expect(artifactFiles(s.fixture)).toEqual(result.artifacts.map((row) => `${row.id}${row.extension}`).sort());
  });

  it('registers a file the manifest forgot, flagged undeclared rather than dropped', async () => {
    const s = setup();
    writeOutput(s.fixture, 'a.csv', 'x\n1\n');
    writeOutput(s.fixture, 'extra.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeManifest(s.fixture, [{ filename: 'a.csv', type: 'csv' }]);
    const result = await s.register();
    expect(result.artifacts.map((row) => [row.filename, row.declared, row.type])).toEqual([['a.csv', true, 'csv'], ['extra.png', false, 'image']]);
    expect(result.undeclaredCount).toBe(1);
    expect(result.artifacts[1]).toMatchObject({ title: null, description: null, contentScan: null });
  });

  it('registers everything as undeclared when there is no manifest, or an invalid one', async () => {
    const s = setup();
    writeOutput(s.fixture, 'b.txt', 'hello');
    writeOutput(s.fixture, 'manifest.json', '{ not json');
    const result = await s.register();
    expect(result.artifacts.map((row) => [row.filename, row.declared, row.type])).toEqual([['b.txt', false, 'text']]);
  });

  it('does not re-count a declared file missing from disk, and registers the rest', async () => {
    const s = setup();
    writeOutput(s.fixture, 'a.csv', 'x\n1\n');
    writeManifest(s.fixture, [{ filename: 'a.csv', type: 'csv' }, { filename: 'missing.csv', type: 'csv' }, { filename: 'gone.png', type: 'image' }]);
    const result = await s.register();
    expect(result.artifacts).toHaveLength(1);
    expect(result.unregisteredOutputCount).toBe(0);
  });

  it('counts a disallowed extension as unregistered, logs it, and keeps the other files', async () => {
    const s = setup();
    writeOutput(s.fixture, 'report.exe', 'MZ');
    writeOutput(s.fixture, 'chart.svg', '<svg onload="alert(1)"/>');
    writeOutput(s.fixture, 'good.csv', 'x\n1\n');
    writeManifest(s.fixture, [{ filename: 'report.exe', type: 'csv' }, { filename: 'chart.svg', type: 'image' }, { filename: 'good.csv', type: 'csv' }]);
    const result = await s.register();
    expect(result.artifacts.map((row) => row.filename)).toEqual(['good.csv']);
    expect(result.unregisteredOutputCount).toBe(2);
    expect(outputFiles(s.fixture)).toEqual(['chart.svg', 'manifest.json', 'report.exe']);
    expect(s.lines.filter((line) => line.includes('output file skipped'))).toHaveLength(2);
  });

  it('registers at most the per-run cap and counts the rest as unregistered', async () => {
    const s = setup();
    for (let index = 0; index < 250; index += 1) writeOutput(s.fixture, `f${String(index).padStart(3, '0')}.txt`, String(index));
    const result = await s.register();
    expect(result.artifacts).toHaveLength(200);
    expect(result.unregisteredOutputCount).toBe(50);
    expect(s.lines.some((line) => line.includes('per-run artifact cap reached'))).toBe(true);
  });

  it('honours a lower configured cap', async () => {
    const s = setup({ maxArtifactsPerRun: 2 });
    for (const name of ['a.txt', 'b.txt', 'c.txt']) writeOutput(s.fixture, name, name);
    const result = await s.register();
    expect([result.artifacts.length, result.unregisteredOutputCount]).toEqual([2, 1]);
  });

  it('never follows a symlink out of the output directory; it is counted unregistered', async (context) => {
    const s = setup();
    const outside = path.join(s.fixture.store.root, 'secret.txt');
    writeFileSync(outside, 'secret');
    try { symlinkSync(outside, path.join(s.fixture.outputDir, 'link.txt')); } catch { context.skip(); }
    writeOutput(s.fixture, 'real.txt', 'ok');
    const result = await s.register();
    expect(result.artifacts.map((row) => row.filename)).toEqual(['real.txt']);
    expect(result.unregisteredOutputCount).toBe(1);
    expect(readFileSync(outside, 'utf8')).toBe('secret');
  });

  it('ignores subdirectories rather than walking them', async () => {
    const s = setup();
    writeOutput(s.fixture, 'top.txt', 'x');
    const nested = path.join(s.fixture.outputDir, 'nested');
    mkdirSync(nested);
    writeFileSync(path.join(nested, 'deep.txt'), 'y');
    const result = await s.register();
    expect(result.artifacts.map((row) => row.filename)).toEqual(['top.txt']);
    expect(result.unregisteredOutputCount).toBe(0);
  });
});

describe('ArtifactRegistrar — the id is the path', () => {
  // Names a filesystem accepts are registered with the name verbatim for display and the id as the path.
  const onDisk = ['..evil.csv', 'ré sumé 日本.csv', `${'x'.repeat(200)}.csv`, 'semi;colon.csv', ...(process.platform === 'win32' ? [] : ['con.csv', 'quote"d.csv', 'back\\slash.csv'])];

  it.each(onDisk)('stores %j verbatim as its label and never as its path', async (name) => {
    const s = setup();
    writeOutput(s.fixture, name, 'x\n1\n');
    writeManifest(s.fixture, [{ filename: name, type: 'csv' }].filter(({ filename }) => !filename.includes('\\')));
    const [row] = (await s.register()).artifacts;
    expect(row!.filename).toBe(name);
    expect(row!.filePath).toBe(`artifacts/${s.fixture.taskId}/${row!.id}.csv`);
    expect(() => resolveWithin(s.fixture.store.root, ...row!.filePath.split('/'))).not.toThrow();
    expect(artifactFiles(s.fixture)).toEqual([`${row!.id}.csv`]);
  });

  // Names no filesystem accepts can only arrive through the manifest, which FEAT-107's parser refuses whole;
  // what is on disk then registers as undeclared, still under its id.
  it.each(['../../../evil.csv', '/etc/passwd', 'C:\\windows\\x.csv', 'nul\u0000byte.csv', 'a\r\nb.csv'])('refuses the manifest naming %j, and nothing escapes the data root', async (name) => {
    const s = setup();
    writeOutput(s.fixture, 'safe.csv', 'x\n1\n');
    writeManifest(s.fixture, [{ filename: name, type: 'csv' }, { filename: 'safe.csv', type: 'csv' }]);
    const result = await s.register();
    expect(result.artifacts.map((row) => [row.filename, row.declared, row.filePath])).toEqual([['safe.csv', false, `artifacts/${s.fixture.taskId}/${result.artifacts[0]!.id}.csv`]]);
    expect(existsSync(path.join(s.fixture.store.root, 'evil.csv'))).toBe(false);
  });
});

describe('ArtifactRegistrar — failure and cancellation', () => {
  it('leaves no rows and moves nothing when cancelled before committing', async () => {
    const s = setup();
    for (const name of ['a.csv', 'b.csv', 'c.csv']) writeOutput(s.fixture, name, 'x\n1\n');
    const controller = new AbortController();
    const pending = s.register(controller.signal);
    controller.abort(new Error('stopped'));
    await expect(pending).rejects.toThrow();
    expect(s.fixture.artifacts.listByRun(s.fixture.run.id)).toHaveLength(0);
    expect(outputFiles(s.fixture)).toEqual(['a.csv', 'b.csv', 'c.csv']);
  });

  it('puts moved files back when the insert fails, so nothing is lost or orphaned', async () => {
    const fixture = createRunFixture();
    fixtures.push(fixture);
    const real = new ArtifactRepository(fixture.store.connection);
    const failing = { allocateIds: (n: number) => real.allocateIds(n), insertMany: () => { throw new RepositoryError('boom'); } };
    const registrar = new ArtifactRegistrar({ paths: fixture.store.paths, artifacts: failing, logger: pino({ level: 'silent' }), maxArtifactsPerRun: 200, scan: { formulaScanRows: 10, maxInflatedBytes: 1 << 30 } });
    writeOutput(fixture, 'a.csv', 'x\n1\n');
    writeOutput(fixture, 'b.txt', 'hi');
    await expect(registrar.registerRunOutputs({ scriptRunId: fixture.run.id, executionId: fixture.executionId, taskId: fixture.taskId, outputDir: fixture.outputDir, manifestJson: null }, new AbortController().signal)).rejects.toThrow(RepositoryError);
    expect(outputFiles(fixture)).toEqual(['a.csv', 'b.txt']);
    expect(artifactFiles(fixture)).toEqual([]);
    expect(real.listByRun(fixture.run.id)).toHaveLength(0);
  });

  it('returns nothing to register for an empty or absent output directory', async () => {
    const s = setup();
    expect(await s.register()).toEqual({ artifacts: [], undeclaredCount: 0, unregisteredOutputCount: 0, totalBytes: 0 });
    const result = await s.registrar.registerRunOutputs({ scriptRunId: s.fixture.run.id, executionId: s.fixture.executionId, taskId: s.fixture.taskId, outputDir: path.join(s.fixture.outputDir, 'nope'), manifestJson: null }, new AbortController().signal);
    expect(result.artifacts).toEqual([]);
  });
});

describe('ArtifactRegistrar — formula scan', () => {
  it('counts formula-prefixed cells, returns counts only, and never logs a cell value or an absolute path', async () => {
    const s = setup();
    writeOutput(s.fixture, 'risky.csv', 'name,value\nSECRET_A,=1+1\n+CELLB,@SUM(A1)\nplain,=HYPERLINK("x")\n');
    writeManifest(s.fixture, [{ filename: 'risky.csv', type: 'csv', title: 'TITLE_SECRET', description: 'DESC_SECRET' }]);
    const [row] = (await s.register()).artifacts;
    expect(JSON.parse(row!.contentScan!)).toMatchObject({ rowsAreCapped: false, formulaCellCount: 4, sampledColumns: 2 });
    const log = s.lines.join('\n');
    for (const secret of ['SECRET_A', 'CELLB', 'HYPERLINK', 'TITLE_SECRET', 'DESC_SECRET', 'risky.csv', s.fixture.store.root, s.fixture.store.root.replace(/\\/g, '\\\\')]) expect(log).not.toContain(secret);
    expect(log).toContain('artifacts registered');
  });

  it('reports the scan as capped past the row limit rather than implying a total', async () => {
    const s = setup({ formulaScanRows: 10 });
    writeOutput(s.fixture, 'long.csv', `v\n${Array.from({ length: 50 }, (_, index) => (index < 3 ? `=${index}` : String(index))).join('\n')}\n`);
    const [row] = (await s.register()).artifacts;
    expect(JSON.parse(row!.contentScan!)).toMatchObject({ scannedRows: 10, rowsAreCapped: true, formulaCellCount: 3 });
  });

  it('is not capped at exactly the limit', async () => {
    const s = setup({ formulaScanRows: 3 });
    writeOutput(s.fixture, 'three.csv', 'v\n1\n2\n3\n');
    const [row] = (await s.register()).artifacts;
    expect(JSON.parse(row!.contentScan!)).toMatchObject({ scannedRows: 3, rowsAreCapped: false });
  });

  it('records no scan, and still registers, a table it cannot read', async () => {
    const s = setup();
    writeOutput(s.fixture, 'broken.xlsx', 'this is not a zip');
    const [row] = (await s.register()).artifacts;
    expect(row).toMatchObject({ type: 'xlsx', contentScan: null });
  });
});
