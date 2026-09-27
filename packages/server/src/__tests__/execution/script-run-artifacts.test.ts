import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RepositoryError } from '@automate/core';
import type { FakePythonRun } from '../../execution/testing/fake-python-runner';
import { createVerificationHarness, type VerificationHarness, type VerificationHarnessOptions } from '../support/verification-harness';

const harnesses: VerificationHarness[] = [];
afterEach(async () => { await Promise.all(harnesses.splice(0).map((h) => h.dispose())); });

const writing = (files: Record<string, string>, declared: readonly string[], result: FakePythonRun['result'] = { stdout: '', exitCode: 0, outcome: 'passed' }): FakePythonRun => ({
  onRun: (request) => {
    const out = request.env.AUTOMATE_OUTPUT_DIR!;
    for (const [name, content] of Object.entries(files)) writeFileSync(path.join(out, name), content);
    writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ artifacts: declared.map((filename) => ({ filename, type: filename.endsWith('.csv') ? 'csv' : 'text', title: filename, description: '' })) }));
  },
  result,
});

async function run(realRun: FakePythonRun, options: VerificationHarnessOptions = {}) {
  const h = await createVerificationHarness({ pythonRuns: [{}, {}, realRun], onApproved: () => undefined, ...options });
  harnesses.push(h);
  expect((await h.runToGate()).status).toBe('awaiting_approval');
  await h.approve();
  const row = await h.scriptRun.run(h.execution.id, new AbortController().signal);
  return { h, row };
}

describe('run settle registers artifacts (FEAT-109)', () => {
  it('stores the counts on script_run, announces them, and still parks the run for review', async () => {
    const { h, row } = await run(writing({ 'totals.csv': 'a\n1\n', 'extra.txt': 'x' }, ['totals.csv']));
    expect(row).toMatchObject({ status: 'succeeded', artifactCount: 2, unregisteredOutputCount: 0, producedOutputCount: 2, declaredOutputCount: 1 });
    expect(h.repos.executions.getById(h.execution.id)?.status).toBe('awaiting_review');
    const types = h.transcript().map(({ type }) => type);
    expect(types.indexOf('artifacts_registered')).toBe(types.indexOf('run_finished') + 1);
    expect(h.transcript().find(({ type }) => type === 'artifacts_registered')).toMatchObject({ artifactCount: 2, undeclaredCount: 1, unregisteredOutputCount: 0, totalBytes: 5 });
    expect(JSON.stringify(h.transcript().find(({ type }) => type === 'artifacts_registered'))).not.toMatch(/totals|extra|runs|artifacts\//);
    const listed = h.repos.artifacts.listByExecution(h.execution.id);
    expect(listed.map((artifact) => [artifact.filename, artifact.declared])).toEqual([['totals.csv', true], ['extra.txt', false]]);
    expect(readdirSync(path.join(h.store.paths.runsDir, String(h.execution.id), 'output'))).toEqual(['manifest.json']);
  });

  it('keeps describing moved files by size, so the run view does not call them missing', async () => {
    const { h } = await run(writing({ 'totals.csv': 'a\n1\n' }, ['totals.csv']));
    expect(h.scriptRun.describe(h.execution.id).declaredOutputs).toEqual([expect.objectContaining({ filename: 'totals.csv', byteSize: 4, present: true })]);
  });

  it('still registers what a failed run produced', async () => {
    const { h, row } = await run(writing({ 'partial.csv': 'a\n1\n' }, ['partial.csv', 'never.csv']));
    expect(row).toMatchObject({ status: 'failed', artifactCount: 1, unregisteredOutputCount: 0 });
    expect(h.repos.executions.getById(h.execution.id)?.status).toBe('failed');
  });

  it('does not change the terminal state when registration throws; every produced file is counted unregistered', async () => {
    const { h, row } = await run(writing({ 'a.csv': 'a\n1\n', 'b.txt': 'b' }, ['a.csv', 'b.txt']), { registrar: () => ({ registerRunOutputs: async () => { throw new RepositoryError('database is busy'); } }) });
    expect(row).toMatchObject({ status: 'succeeded', artifactCount: 0, unregisteredOutputCount: 2 });
    expect(h.repos.executions.getById(h.execution.id)?.status).toBe('awaiting_review');
    expect(h.transcript().find(({ type }) => type === 'artifacts_registered')).toMatchObject({ artifactCount: 0, unregisteredOutputCount: 2 });
  });

  it('leaves the counts NULL when registration is not wired, as FEAT-107 did', async () => {
    const { h, row } = await run(writing({ 'a.csv': 'a\n1\n' }, ['a.csv']), { registrar: false });
    expect(row).toMatchObject({ artifactCount: null, unregisteredOutputCount: null });
    expect(h.transcript().some(({ type }) => type === 'artifacts_registered')).toBe(false);
  });
});
