import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PythonRunResult } from '@automate/core';
import { FakePythonRunner, type FakePythonRun } from '../../../execution/testing/fake-python-runner';
import { runTestCheck } from '../../../verification/checks/test-check';
import { capHeadTail } from '../../../execution/output-cap';

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'automate-testcheck-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const SHA = 'a'.repeat(64);
function request(runs: readonly FakePythonRun[], signal = new AbortController().signal) {
  const runner = new FakePythonRunner(runs);
  const verifyDir = path.join(root, 'runs', '7', 'verify');
  const inputDir = path.join(verifyDir, 'input');
  mkdirSync(inputDir, { recursive: true });
  return { runner, verifyDir, run: () => runTestCheck({ runner, executionId: 7, versionDir: path.join(root, 'scripts', '7', 'attempt-2'), fixtures: { directory: inputDir, files: [{ uploadId: 1, sha256: SHA, rowCount: 200 }] }, verifyDir, timeoutMs: 120_000, signal }) };
}
const result = (overrides: Partial<PythonRunResult>): FakePythonRun => ({ result: overrides });

describe('independent test re-run', () => {
  it('passes a zero exit with "3 passed" and records the fixture', async () => {
    const { run } = request([result({ outcome: 'passed', exitCode: 0, stdout: '...\n3 passed in 0.12s\n' })]);
    const outcome = await run();
    expect(outcome).toMatchObject({ status: 'passed', findings: [], summary: '3 of 3 tests passed against 200 synthetic rows' });
    expect(outcome.detail).toMatchObject({ total: 3, passed: 3, failed: 0, fixtureSha256: SHA, fixtureRowCount: 200 });
  });
  it('fails a non-zero exit with "1 failed, 2 passed" and a blocking finding naming the counts', async () => {
    const outcome = await request([result({ outcome: 'failed', exitCode: 1, stdout: 'F..\n1 failed, 2 passed in 0.30s\n' })]).run();
    expect(outcome.status).toBe('failed');
    expect(outcome.findings).toEqual([expect.objectContaining({ ruleCode: 'tests_failed', isBlocking: true, message: '1 of 3 tests failed when this app re-ran them.' })]);
    expect(outcome.summary).toBe('1 failing test: 2 of 3 passed against 200 synthetic rows');
  });
  it('refuses to trust a zero exit with an unparseable summary: errored, not passed', async () => {
    const outcome = await request([result({ outcome: 'passed', exitCode: 0, stdout: 'everything is fine, trust me\n' })]).run();
    expect(outcome.status).toBe('errored');
    expect(outcome.summary).toMatch(/without a pytest summary/);
  });
  it('treats a collection error as errored', async () => {
    const outcome = await request([result({ outcome: 'errored', exitCode: 2, stdout: 'ERROR collecting test_main.py\nInterrupted: 1 error during collection\n1 error in 0.10s\n' })]).run();
    expect(outcome).toMatchObject({ status: 'errored' });
    expect(outcome.summary).toMatch(/could not be collected/);
  });
  it('names the limit in a timeout', async () => {
    const outcome = await request([result({ outcome: 'timed_out', exitCode: null, stdout: '' })]).run();
    expect(outcome.summary).toBe('The test re-run took longer than 2 minutes and was stopped, so the tests did not finish.');
  });
  it('settles an abort as errored rather than hanging', async () => {
    let release!: () => void;
    const controller = new AbortController();
    const { run } = request([{ waitUntil: new Promise<void>((resolve) => { release = resolve; }) }], controller.signal);
    const pending = run();
    controller.abort();
    const outcome = await pending;
    release();
    expect(outcome).toMatchObject({ status: 'errored' });
    expect(outcome.summary).toMatch(/aborted/);
  });
  it('treats zero tests and a disagreeing exit code as errored', async () => {
    expect((await request([result({ outcome: 'passed', exitCode: 0, stdout: 'no tests ran in 0.01s\n' })]).run()).status).toBe('errored');
    expect((await request([result({ outcome: 'passed', exitCode: 0, stdout: '1 failed, 2 passed in 0.3s\n' })]).run()).status).toBe('errored');
    expect((await request([result({ outcome: 'failed', exitCode: 1, stdout: '3 passed in 0.3s\n' })]).run()).status).toBe('errored');
  });
  it('is errored when the runner itself throws', async () => {
    const runner = new FakePythonRunner();
    runner.run = () => Promise.reject(new Error('spawn uv ENOENT'));
    const verifyDir = path.join(root, 'verify');
    const outcome = await runTestCheck({ runner, executionId: 7, versionDir: root, fixtures: { directory: verifyDir, files: [] }, verifyDir, signal: new AbortController().signal });
    expect(outcome.status).toBe('errored');
    expect(outcome.summary).not.toMatch(/ENOENT/);
  });
  it('points both directories inside the run, never at the uploads directory, and discards the scratch output', async () => {
    const { run, runner, verifyDir } = request([{ onRun: (req) => writeFileSync(path.join(req.env.AUTOMATE_OUTPUT_DIR!, 'manifest.json'), '{}'), result: { stdout: '1 passed in 0.1s' } }]);
    await run();
    const env = runner.requests[0]!.env;
    expect(env.AUTOMATE_INPUT_DIR).toBe(path.join(verifyDir, 'input'));
    expect(env.AUTOMATE_OUTPUT_DIR).toBe(path.join(verifyDir, 'output'));
    expect(JSON.stringify(env)).not.toMatch(/uploads/);
    expect(runner.requests[0]!.args).toEqual(['-m', 'pytest', '-q', '--tb=native', '-rfE', '-p', 'no:cacheprovider']);
    expect(existsSync(path.join(verifyDir, 'output'))).toBe(false);
  });
  it('keeps only a bounded excerpt of raw output', async () => {
    const outcome = await request([result({ stdout: `${'x'.repeat(20_000)}\n3 passed in 0.1s` })]).run();
    const detail = outcome.detail as { outputExcerpt: string; outputTruncated: boolean };
    expect(Buffer.byteLength(detail.outputExcerpt)).toBeLessThan(4_200);
    expect(detail.outputTruncated).toBe(true);
  });
});

describe('capHeadTail', () => {
  it('keeps short text, and head plus tail of long text without splitting a character', () => {
    expect(capHeadTail('abc', 10)).toEqual({ text: 'abc', truncated: false });
    const cut = capHeadTail(`HEAD${'é'.repeat(1000)}TAIL`, 64);
    expect(cut.truncated).toBe(true);
    expect(cut.text.startsWith('HEAD')).toBe(true);
    expect(cut.text.endsWith('TAIL')).toBe(true);
    expect(cut.text).not.toContain('�');
  });
});
