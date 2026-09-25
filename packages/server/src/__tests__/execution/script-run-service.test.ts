import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import pino from 'pino';
import { describeLimitBreach } from '@automate/core';
import type { FakePythonRun } from '../../execution/testing/fake-python-runner';
import { ScriptRunService } from '../../execution/script-run-service';
import { sha256File } from '../../execution/input-stager';
import { TRUNCATION_MARKER } from '../../execution/output-cap';
import { createVerificationHarness, type VerificationHarness, type VerificationHarnessOptions } from '../support/verification-harness';

const harnesses: VerificationHarness[] = [];
afterEach(async () => { await Promise.all(harnesses.splice(0).map((h) => h.dispose())); });

/** Writes a manifest and the files it declares, as a well-behaved script would. */
const producing = (declared: readonly string[], written: readonly string[] = declared, extra: Partial<FakePythonRun> = {}): FakePythonRun => ({
  onRun: (request) => {
    const out = request.env.AUTOMATE_OUTPUT_DIR!;
    for (const name of written) writeFileSync(path.join(out, name), 'region,total\nNorth,10\n');
    writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ artifacts: declared.map((filename) => ({ filename, type: 'csv', title: filename, description: '' })) }));
  },
  result: { stdout: 'done\n', exitCode: 0, outcome: 'passed' },
  ...extra,
});

/** Generate, verify, and stop at the gate; the real run is the third Python run. */
async function atGate(realRun: FakePythonRun, options: VerificationHarnessOptions = {}) {
  const h = await createVerificationHarness({ pythonRuns: [{}, {}, realRun], onApproved: () => undefined, ...options });
  harnesses.push(h);
  expect((await h.runToGate()).status).toBe('awaiting_approval');
  return h;
}
async function approveAndRun(h: VerificationHarness) {
  await h.approve();
  return h.scriptRun.run(h.execution.id, new AbortController().signal);
}
const count = (h: VerificationHarness, table: string) => (h.store.connection.client.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const requests = (h: VerificationHarness) => (h.runner as unknown as { requests: { args: readonly string[]; env: Record<string, string> }[] }).requests;
const uploadPath = (h: VerificationHarness) => path.join(h.store.root, ...h.upload!.filePath.split('/'));

describe('ScriptRunService', () => {
  it('settles succeeded and parks the execution for review — exit 0 is not acceptance', async () => {
    const h = await atGate(producing(['totals.csv']));
    const row = await approveAndRun(h);
    expect(row).toMatchObject({ status: 'succeeded', exitCode: 0, manifestPresent: true, declaredOutputCount: 1, producedOutputCount: 1, outputTruncated: false, dirPath: `runs/${h.execution.id}` });
    expect(h.repos.executions.getById(h.execution.id)?.status).toBe('awaiting_review');
    const finished = h.transcript().find(({ type }) => type === 'run_finished');
    expect(finished).toMatchObject({ status: 'succeeded', declaredOutputCount: 1, producedOutputCount: 1 });
    expect(JSON.stringify(finished)).not.toContain('done');
    const request = requests(h).at(-1)!;
    expect(request.args).toEqual(['main.py']);
    expect(request.env.AUTOMATE_INPUT_DIR).toBe(path.join(h.store.paths.runsDir, String(h.execution.id), 'input'));
    expect(request.env.AUTOMATE_OUTPUT_DIR).toBe(path.join(h.store.paths.runsDir, String(h.execution.id), 'output'));
  });

  it.each([
    ['a zero exit with no manifest', { result: { exitCode: 0, outcome: 'passed' } } as FakePythonRun, 'failed', 'The script finished but did not say what it produced.'],
    ['a manifest declaring a file that is not on disk', producing(['a.csv', 'b.csv'], ['a.csv']), 'failed', 'The script said it would produce 2 files, but 1 of them was not written.'],
    ['a non-zero exit', { result: { exitCode: 3, outcome: 'errored', stderr: 'Traceback…' } } as FakePythonRun, 'failed', 'The script stopped with an error (exit code 3) before it finished. Its output is shown below.'],
    ['a timeout', { result: { exitCode: null, outcome: 'timed_out' } } as FakePythonRun, 'timed_out', 'The script ran longer than 15 minutes and was stopped. Nothing it produced has been kept as a result.'],
  ])('settles %s with a message a non-programmer can act on', async (_name, run, status, message) => {
    const h = await atGate(run);
    const row = await approveAndRun(h);
    expect(row?.status).toBe(status);
    expect(h.repos.executions.getById(h.execution.id)).toMatchObject({ status: 'failed', errorCode: status === 'timed_out' ? 'SCRIPT_LIMIT_EXCEEDED' : 'RUN_OUTPUT_MISSING', errorMessage: status === 'timed_out' ? 'This script ran for 15 minutes without finishing and was stopped.' : message });
  });

  it('stores the exit code of a failing run', async () => {
    const h = await atGate({ result: { exitCode: 3, outcome: 'errored' } });
    expect((await approveAndRun(h))?.exitCode).toBe(3);
  });

  it('settles aborted and stops the process when the run is cancelled', async () => {
    const h = await atGate({ waitUntil: new Promise(() => undefined) });
    await h.approve();
    h.scriptRun.start(h.execution.id);
    for (let spin = 0; spin < 100 && requests(h).length < 3; spin += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    await h.registry.abort(h.execution.id);
    expect(h.repos.scriptRuns.getByExecution(h.execution.id)).toMatchObject({ status: 'aborted' });
    expect(h.repos.executions.getById(h.execution.id)?.status).toBe('aborted');
  });

  it('persists an output limit separately from a user abort', async () => {
    const h = await atGate({ result: { exitCode: null, outcome: 'errored', stderr: describeLimitBreach('output_bytes') } });
    const row = await approveAndRun(h);
    expect(row).toMatchObject({ status: 'failed', limitBreached: 'output_bytes' });
    expect(h.repos.executions.getById(h.execution.id)).toMatchObject({ status: 'failed', errorCode: 'SCRIPT_LIMIT_EXCEEDED' });
  });

  it('refuses without an approval, writes no row, and spawns nothing', async () => {
    const h = await atGate(producing(['totals.csv']));
    h.store.connection.client.prepare("UPDATE execution SET status = 'executing' WHERE id = ?").run(h.execution.id);
    const spawned = requests(h).length;
    expect(await h.scriptRun.run(h.execution.id, new AbortController().signal)).toBeUndefined();
    expect(count(h, 'script_run')).toBe(0);
    expect(requests(h)).toHaveLength(spawned);
    expect(h.repos.executions.getById(h.execution.id)).toMatchObject({ status: 'failed', errorCode: 'EXECUTION_NOT_APPROVED' });
  });

  it('refuses a run whose code changed after approval — the gate is in front of the spawn', async () => {
    const h = await atGate(producing(['totals.csv']));
    await h.approve();
    h.store.connection.client.prepare("UPDATE code_file SET content = content || '# changed after approval' WHERE path = 'main.py'").run();
    const spawned = requests(h).length;
    expect(await h.scriptRun.run(h.execution.id, new AbortController().signal)).toBeUndefined();
    expect(requests(h)).toHaveLength(spawned);
    expect(count(h, 'script_run')).toBe(0);
    expect(h.repos.executions.getById(h.execution.id)).toMatchObject({ status: 'failed', errorCode: 'APPROVAL_STALE' });
    expect(h.transcript().some((event) => event.type === 'failed')).toBe(true);
  });

  it('refuses a run whose runtime changed after approval', async () => {
    const h = await atGate(producing(['totals.csv']));
    await h.approve();
    h.probe.upgrade({ uvVersion: 'uv 0.12.0' });
    const spawned = requests(h).length;
    await h.scriptRun.run(h.execution.id, new AbortController().signal);
    expect(requests(h)).toHaveLength(spawned);
    expect(h.repos.executions.getById(h.execution.id)?.errorMessage).toMatch(/Python environment changed/);
  });

  it('hands the script a verified copy and leaves the original byte-identical', async () => {
    const h = await atGate({ ...producing(['totals.csv']), onRun: (request) => { writeFileSync(path.join(request.env.AUTOMATE_INPUT_DIR!, h.upload!.storedFilename), 'overwritten by a buggy script'); producing(['totals.csv']).onRun!(request); } });
    const before = await sha256File(uploadPath(h));
    const row = await approveAndRun(h);
    expect(await sha256File(uploadPath(h))).toBe(before);
    expect(JSON.parse(row!.inputManifest)).toEqual([{ uploadId: h.upload!.id, storedFilename: h.upload!.storedFilename, sha256: h.upload!.sha256, byteSize: h.upload!.byteSize }]);
  });

  it('refuses when the copy does not match the uploaded file, before spawning', async () => {
    const h = await atGate(producing(['totals.csv']));
    await h.approve();
    writeFileSync(uploadPath(h), `${readFileSync(uploadPath(h), 'utf8')}tampered\n`);
    const spawned = requests(h).length;
    await h.scriptRun.run(h.execution.id, new AbortController().signal);
    expect(requests(h)).toHaveLength(spawned);
    expect(h.repos.executions.getById(h.execution.id)).toMatchObject({ status: 'failed', errorCode: 'INPUT_COPY_MISMATCH' });
  });

  it('stores 2 MiB of output truncated, keeping head and tail', async () => {
    const big = `HEAD-${'x'.repeat(2 * 1024 * 1024)}-TAIL`;
    const h = await atGate({ ...producing(['totals.csv']), result: { stdout: big, exitCode: 0, outcome: 'passed' } });
    const row = await approveAndRun(h);
    expect(row?.outputTruncated).toBe(true);
    expect(row!.stdout!.startsWith('HEAD-')).toBe(true);
    expect(row!.stdout!.endsWith('-TAIL')).toBe(true);
    expect(row!.stdout).toContain(TRUNCATION_MARKER);
    expect(Buffer.byteLength(row!.stdout!)).toBeLessThanOrEqual(1_048_576 + TRUNCATION_MARKER.length + 8);
  });

  it('never writes a byte of captured output to a log', async () => {
    const SECRET = 'QZX-CELL-VALUE-77aa';
    const h = await atGate({ ...producing(['totals.csv']), result: { stdout: `row: ${SECRET}\n`, stderr: `warn ${SECRET}\n`, exitCode: 0, outcome: 'passed' } });
    const lines: string[] = [];
    const logger = pino({ level: 'debug' }, new Writable({ write(chunk, _encoding, done) { lines.push(String(chunk)); done(); } }));
    const service = new ScriptRunService({ executions: h.repos.executions, versions: h.repos.versions, uploads: h.repos.uploads, scriptRuns: h.repos.scriptRuns, runner: h.runner, probe: h.probe, project: (id) => h.workspace.project(id), paths: h.store.paths, state: h.state, publish: h.publish, track: (id, job) => h.registry.track(id, job), logger });
    await h.approve();
    const row = await service.run(h.execution.id, new AbortController().signal);
    expect(row?.stdout).toContain(SECRET);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('')).not.toContain(SECRET);
  });

  it('describes a run with filenames only and no location', async () => {
    const h = await atGate(producing(['totals.csv']));
    await approveAndRun(h);
    const described = h.scriptRun.describe(h.execution.id);
    expect(described.declaredOutputs).toEqual([{ filename: 'totals.csv', type: 'csv', title: 'totals.csv', description: '', byteSize: 22, present: true }]);
    const text = JSON.stringify(described);
    for (const needle of [h.store.root, h.store.root.replace(/\\/g, '/'), h.store.root.replace(/\\/g, '\\\\')]) expect(text).not.toContain(needle);
  });
});
