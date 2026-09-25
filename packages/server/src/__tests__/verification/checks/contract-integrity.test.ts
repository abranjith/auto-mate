import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createFinalizedHarness, workbookBytes } from '../../support/verification-fixtures';
import { ROW_11_SENTINEL } from '../../support/generation-fixtures';
import { runIntegrityCheck } from '../../../verification/checks/integrity-check';
import { checkEntrypoint, checkInputs, checkOutputs, type ProfiledInput } from '../../../verification/checks/contract-checks';
import type { CodeVersionWithFiles } from '../../../db/repositories/code-version-repository';

type Harness = Awaited<ReturnType<typeof createFinalizedHarness>>;
const harnesses: Harness[] = [];
afterEach(async () => { await Promise.all(harnesses.splice(0).map((h) => h.dispose())); });
async function finalized(options: Parameters<typeof createFinalizedHarness>[0] = {}) {
  const h = await createFinalizedHarness(options);
  harnesses.push(h);
  expect(h.final).not.toBeNull();
  return h;
}
const deps = (h: Harness) => ({ project: (id: number) => h.workspace.project(id), fixtures: h.fixtureService });
const fixtureDir = (h: Harness) => path.join(h.store.paths.runsDir, String(h.execution.id), 'verify', 'input');
const inputsOf = (h: Harness): ProfiledInput[] => h.uploads.map((upload) => ({ storedFilename: upload.storedFilename, tables: h.repos.profiles.listByUpload(upload.id) }));
const withVersion = (h: Harness, patch: Partial<CodeVersionWithFiles>): CodeVersionWithFiles => ({ ...h.final!, ...patch });
/** Every serialized finding: no absolute path, no data root, no cell content. */
const assertClean = (h: Harness, value: unknown) => {
  const text = JSON.stringify(value);
  for (const needle of [h.store.root, h.store.root.replace(/\\/g, '/'), h.store.root.replace(/\\/g, '\\\\'), ROW_11_SENTINEL, 'North', 'South']) expect(text).not.toContain(needle);
};

describe('integrity check', () => {
  it('passes an untouched version, re-derives the CSV fixture byte-identically, and projects the files', async () => {
    const h = await finalized();
    const recorded = h.repos.fixtures.listByExecution(h.execution.id);
    const result = await runIntegrityCheck(deps(h), h.final!, recorded, fixtureDir(h));
    expect(result.outcome).toMatchObject({ status: 'passed', findings: [] });
    expect(result.fixtures?.files[0]?.sha256).toBe(recorded[0]!.sha256);
    expect(result.versionDir).toBe(h.workspace.attemptDir(h.final!));
    assertClean(h, result.outcome);
  });
  it('re-derives an XLSX fixture byte-identically — FEAT-106\'s generator is deterministic', async () => {
    const h = await finalized({ files: [{ name: 'book.xlsx', bytes: await workbookBytes(), format: 'xlsx' }], finalize: { declaredInputs: [] } });
    const recorded = h.repos.fixtures.listByExecution(h.execution.id);
    const result = await runIntegrityCheck(deps(h), h.final!, recorded, fixtureDir(h));
    expect(result.outcome.findings).toEqual([]);
    expect(result.fixtures?.files[0]?.sha256).toBe(recorded[0]!.sha256);
  });
  it('rebuilds a missing attempt directory from the database and passes', async () => {
    const h = await finalized();
    const dir = h.workspace.attemptDir(h.final!);
    rmSync(dir, { recursive: true, force: true });
    const result = await runIntegrityCheck(deps(h), h.final!, h.repos.fixtures.listByExecution(h.execution.id), fixtureDir(h));
    expect(result.outcome.status).toBe('passed');
    for (const file of h.final!.files) expect(readFileSync(path.join(dir, file.path), 'utf8')).toBe(file.content);
  });
  it('blocks on a mutated file, naming the file', async () => {
    const h = await finalized();
    const mutated = withVersion(h, { files: h.final!.files.map((file) => (file.path === 'main.py' ? { ...file, content: `${file.content}# changed\n` } : file)) });
    const result = await runIntegrityCheck(deps(h), mutated, h.repos.fixtures.listByExecution(h.execution.id), fixtureDir(h));
    expect(result.outcome.status).toBe('failed');
    expect(result.outcome.findings.map(({ ruleCode, filePath, isBlocking }) => [ruleCode, filePath, isBlocking])).toEqual([['file_digest_mismatch', 'main.py', true], ['digest_mismatch', null, true]]);
    expect(result.versionDir).toBeNull();
    assertClean(h, result.outcome);
  });
  it('blocks on a version digest that does not match its files', async () => {
    const h = await finalized();
    const result = await runIntegrityCheck(deps(h), withVersion(h, { contentDigest: '0'.repeat(64) }), h.repos.fixtures.listByExecution(h.execution.id), fixtureDir(h));
    expect(result.outcome.findings.map(({ ruleCode }) => ruleCode)).toEqual(['digest_mismatch']);
    expect(result.outcome.findings[0]?.message).toMatch(/fingerprint recorded for this version/);
  });
  it('blocks on a fixture whose re-derived bytes differ, naming reproducibility', async () => {
    const h = await finalized();
    const recorded = h.repos.fixtures.listByExecution(h.execution.id).map((row) => ({ ...row, sha256: 'f'.repeat(64) }));
    const result = await runIntegrityCheck(deps(h), h.final!, recorded, fixtureDir(h));
    expect(result.outcome.findings).toEqual([expect.objectContaining({ ruleCode: 'fixture_not_reproducible', isBlocking: true, message: expect.stringMatching(/could not be reproduced exactly/) })]);
  });
  it('never writes into the real upload directory', async () => {
    const h = await finalized();
    await runIntegrityCheck(deps(h), h.final!, h.repos.fixtures.listByExecution(h.execution.id), fixtureDir(h));
    expect(existsSync(path.join(fixtureDir(h), h.upload!.storedFilename))).toBe(true);
    expect(readFileSync(path.join(fixtureDir(h), h.upload!.storedFilename), 'utf8')).not.toContain(ROW_11_SENTINEL);
  });
});

describe('contract_entrypoint', () => {
  it('passes a script entrypoint and fails a test file or a missing file', async () => {
    const h = await finalized();
    expect(checkEntrypoint(h.final!).status).toBe('passed');
    const test = checkEntrypoint(withVersion(h, { entrypoint: 'test_main.py' }));
    expect(test).toMatchObject({ status: 'failed', findings: [expect.objectContaining({ ruleCode: 'entrypoint_not_script', isBlocking: true })] });
    expect(checkEntrypoint(withVersion(h, { entrypoint: 'nope.py' })).findings[0]?.ruleCode).toBe('entrypoint_missing');
  });
});

describe('contract_outputs', () => {
  const outputs = (...entries: unknown[]) => JSON.stringify(entries);
  const ok = (filename: string) => ({ filename, type: 'csv', title: 't', description: '' });
  it('passes two distinct valid entries', async () => {
    const h = await finalized();
    expect(checkOutputs(withVersion(h, { declaredOutputs: outputs(ok('a.csv'), ok('b.csv')) }))).toMatchObject({ status: 'passed', summary: 'Declares 2 outputs' });
  });
  it.each([
    ['an empty array', outputs(), 'outputs_empty'],
    ['a duplicate filename', outputs(ok('a.csv'), ok('a.csv')), 'duplicate_output'],
    ['a traversal', outputs(ok('../escape.csv')), 'invalid_output_name'],
    ['an absolute path', outputs(ok('/tmp/x.csv')), 'invalid_output_name'],
    ['an unknown type', outputs({ ...ok('a.exe'), type: 'exe' }), 'invalid_output_type'],
    ['unreadable JSON', '{', 'outputs_unreadable'],
  ])('fails on %s', async (_name, declared, rule) => {
    const h = await finalized();
    const outcome = checkOutputs(withVersion(h, { declaredOutputs: declared }));
    expect(outcome.status).toBe('failed');
    expect(outcome.findings.map(({ ruleCode }) => ruleCode)).toContain(rule);
    expect(outcome.findings.every(({ isBlocking }) => isBlocking)).toBe(true);
  });
});

describe('contract_inputs', () => {
  const declare = (h: Harness, columns: { name: string; type: string }[]) => withVersion(h, { declaredInputs: JSON.stringify([{ fileRole: h.upload!.storedFilename, requiredColumns: columns }]) });
  it('passes when every column matches', async () => {
    const h = await finalized();
    const outcome = checkInputs(declare(h, [{ name: 'region', type: 'string' }, { name: 'amount', type: 'decimal' }, { name: 'order_id', type: 'integer' }]), inputsOf(h));
    expect(outcome).toMatchObject({ status: 'passed', findings: [], summary: 'All 3 required columns found' });
  });
  it('blocks on a missing column, naming the column and the file and no cell value', async () => {
    const h = await finalized();
    const outcome = checkInputs(declare(h, [{ name: 'discount', type: 'decimal' }]), inputsOf(h));
    expect(outcome.status).toBe('failed');
    expect(outcome.findings[0]).toMatchObject({ ruleCode: 'missing_column', isBlocking: true });
    expect(outcome.findings[0]!.message).toContain('"discount"');
    expect(outcome.findings[0]!.message).toContain(h.upload!.storedFilename);
    assertClean(h, outcome);
  });
  it('is advisory for integer declared against a profiled decimal', async () => {
    const h = await finalized();
    const outcome = checkInputs(declare(h, [{ name: 'amount', type: 'integer' }]), inputsOf(h));
    expect(outcome.status).toBe('passed');
    expect(outcome.findings[0]).toMatchObject({ ruleCode: 'type_mismatch', isBlocking: false, severity: 'low' });
    expect(outcome.findings[0]!.message).toMatch(/as integer, but it looks like decimal/);
  });
  it('blocks when the declared file is not attached', async () => {
    const h = await finalized();
    const outcome = checkInputs(withVersion(h, { declaredInputs: JSON.stringify([{ fileRole: 'other.csv', requiredColumns: [] }]) }), inputsOf(h));
    expect(outcome.findings[0]).toMatchObject({ ruleCode: 'missing_input', isBlocking: true });
  });
  it('is skipped, non-blocking, with no uploads', async () => {
    const h = await finalized();
    expect(checkInputs(h.final!, [])).toMatchObject({ status: 'skipped', findings: [] });
  });
});
