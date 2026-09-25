import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodeVersionImmutableError, CodeVersionNotFoundError, InvalidCodePathError, computeVersionDigest } from '@automate/core';
import { ensureAppDirectories, getAppPaths } from '../../../config/app-paths';
import { openDatabase, type DatabaseConnection } from '../../../db/client';
import { migrateDatabase } from '../../../db/migrate';
import { TaskRepository } from '../../../db/repositories/task-repository';
import { ExecutionRepository } from '../../../db/repositories/execution-repository';
import { UploadRepository } from '../../../db/repositories/upload-repository';
import { CodeVersionRepository } from '../../../db/repositories/code-version-repository';
import { GenerationAttemptRepository } from '../../../db/repositories/generation-attempt-repository';
import { SyntheticFixtureRepository } from '../../../db/repositories/synthetic-fixture-repository';

const roots: string[] = [];
const connections: DatabaseConnection[] = [];
afterEach(() => { connections.splice(0).forEach((item) => item.close()); roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'automate-generation-'));
  roots.push(root);
  const paths = getAppPaths(root);
  ensureAppDirectories(paths);
  const connection = openDatabase(paths);
  connections.push(connection);
  migrateDatabase(connection);
  const created = new TaskRepository(connection).createWithExecution('Summarize sales');
  return { connection, ...created, versions: new CodeVersionRepository(connection), attempts: new GenerationAttemptRepository(connection), fixtures: new SyntheticFixtureRepository(connection), executions: new ExecutionRepository(connection), uploads: new UploadRepository(connection) };
}
const count = (connection: DatabaseConnection, table: string) => (connection.client.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count;
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

describe('CodeVersionRepository', () => {
  it('round-trips a draft with three files including a 256 KiB one and unicode, and seals it with the core digest', () => {
    const { versions, execution } = setup();
    const draft = versions.openDraft(execution.id, 1);
    expect(draft).toMatchObject({ status: 'draft', contentDigest: null, sealedAt: null, dirPath: `scripts/${execution.id}/attempt-1`, entrypoint: 'main.py', isFinal: false });
    const big = 'x'.repeat(262_144);
    versions.putFile(draft.id, { path: 'main.py', role: 'script', content: big });
    versions.putFile(draft.id, { path: 'test_main.py', role: 'test', content: 'def test_ok():\n    assert "日本" != "🐍"\n' });
    versions.putFile(draft.id, { path: 'lib/helpers.py', role: 'script', content: 'NAME = "Zoë"\n' });
    const stored = versions.getByIdWithFiles(draft.id)!;
    expect(stored.files.map(({ path: file }) => file)).toEqual(['lib/helpers.py', 'main.py', 'test_main.py']);
    expect(stored.files.find(({ path: file }) => file === 'main.py')).toMatchObject({ byteSize: 262_144, sha256: sha(big) });
    expect(stored.files.find(({ path: file }) => file === 'lib/helpers.py')?.byteSize).toBe(Buffer.byteLength('NAME = "Zoë"\n'));
    const sealed = versions.seal(draft.id);
    expect(sealed.status).toBe('sealed');
    expect(sealed.contentDigest).toBe(computeVersionDigest(stored.files));
    expect(sealed.sealedAt).toBeInstanceOf(Date);
    expect(() => versions.seal(draft.id)).toThrow(CodeVersionImmutableError);
  });

  it('refuses any file change after sealing and writes nothing', () => {
    const { versions, execution, connection } = setup();
    const draft = versions.openDraft(execution.id, 1);
    versions.putFile(draft.id, { path: 'main.py', role: 'script', content: 'print(1)\n' });
    versions.seal(draft.id);
    expect(() => versions.putFile(draft.id, { path: 'main.py', role: 'script', content: 'print(2)\n' })).toThrow(CodeVersionImmutableError);
    expect(() => versions.putFile(draft.id, { path: 'other.py', role: 'script', content: 'x' })).toThrow(CodeVersionImmutableError);
    expect(count(connection, 'code_file')).toBe(1);
    expect(versions.getByIdWithFiles(draft.id)!.files[0]!.content).toBe('print(1)\n');
    expect(() => versions.putFile(999, { path: 'main.py', role: 'script', content: 'x' })).toThrow(CodeVersionNotFoundError);
  });

  it('replaces a file written twice at one path, validates paths again, and refuses to seal an empty draft', () => {
    const { versions, execution, connection } = setup();
    const draft = versions.openDraft(execution.id, 1);
    versions.putFile(draft.id, { path: 'main.py', role: 'script', content: 'a' });
    versions.putFile(draft.id, { path: './main.py', role: 'script', content: 'b' });
    expect(versions.listFiles([draft.id]).map(({ content }) => content)).toEqual(['b']);
    expect(() => versions.putFile(draft.id, { path: '../x.py', role: 'script', content: 'x' })).toThrow(InvalidCodePathError);
    expect(count(connection, 'code_file')).toBe(1);
    const other = new TaskRepository(connection).createWithExecution('Other').execution;
    const empty = versions.openDraft(other.id, 1);
    expect(() => versions.seal(empty.id)).toThrow(/no files cannot be sealed/);
    expect(versions.getById(empty.id)?.status).toBe('draft');
  });

  it('enforces one draft and one final version per execution, and unique attempt numbers and paths', () => {
    const { versions, execution, connection } = setup();
    const other = new TaskRepository(connection).createWithExecution('Other').execution;
    const first = versions.openDraft(execution.id, 1);
    expect(() => versions.openDraft(execution.id, 2)).toThrow();
    versions.putFile(first.id, { path: 'main.py', role: 'script', content: 'a' });
    expect(() => connection.client.prepare("INSERT INTO code_file (code_version_id, path, role, content, byte_size, sha256) VALUES (?, 'main.py', 'script', 'b', 1, ?)").run(first.id, 'b'.repeat(64))).toThrow();
    versions.seal(first.id);
    expect(() => versions.openDraft(execution.id, 1)).toThrow();
    const second = versions.openDraft(execution.id, 2);
    versions.putFile(second.id, { path: 'main.py', role: 'script', content: 'b' });
    versions.seal(second.id);
    const details = { entrypoint: 'main.py', declaredInputs: [], declaredOutputs: [], summary: 'Totals' };
    versions.markFinal(first.id, details);
    expect(() => versions.markFinal(second.id, details)).toThrow();
    const elsewhere = versions.openDraft(other.id, 1);
    versions.putFile(elsewhere.id, { path: 'main.py', role: 'script', content: 'c' });
    versions.seal(elsewhere.id);
    expect(versions.markFinal(elsewhere.id, details).isFinal).toBe(true);
    expect(versions.findFinal(execution.id)?.id).toBe(first.id);
  });

  it('rejects a draft with a digest, a sealed row without one, and attempt 0 at the schema', () => {
    const { execution, connection } = setup();
    const insert = (status: string, digest: string | null, sealed: number | null, attempt = 1) => connection.client.prepare('INSERT INTO code_version (execution_id, attempt, status, content_digest, dir_path, sealed_at) VALUES (?, ?, ?, ?, ?, ?)').run(execution.id, attempt, status, digest, 'scripts/x', sealed);
    expect(() => insert('draft', 'a'.repeat(64), null)).toThrow(/CHECK/);
    expect(() => insert('sealed', null, 1)).toThrow(/CHECK/);
    expect(() => insert('sealed', 'a'.repeat(64), null)).toThrow(/CHECK/);
    expect(() => insert('draft', null, null, 0)).toThrow(/CHECK/);
    expect(() => insert('mystery', 'a'.repeat(64), 1)).toThrow(/CHECK/);
  });

  it('records tested outcomes and finalizes a failing version — finalization is not a gate', () => {
    const { versions, execution } = setup();
    const draft = versions.openDraft(execution.id, 1);
    versions.putFile(draft.id, { path: 'main.py', role: 'script', content: 'a' });
    expect(() => versions.markTested(draft.id, true)).toThrow(/sealed first/);
    versions.seal(draft.id);
    expect(versions.markTested(draft.id, false)).toMatchObject({ status: 'tested_fail', testsPassed: false });
    const final = versions.markFinal(draft.id, { entrypoint: 'main.py', declaredInputs: [{ fileRole: 'sales.csv', requiredColumns: [{ name: 'region', type: 'string' }] }], declaredOutputs: [], summary: '<script>alert(1)</script>' });
    expect(final).toMatchObject({ isFinal: true, testsPassed: false, summary: '<script>alert(1)</script>' });
    expect(JSON.parse(final.declaredInputs!)).toEqual([{ fileRole: 'sales.csv', requiredColumns: [{ name: 'region', type: 'string' }] }]);
    expect(versions.getById(draft.id)!.contentDigest).toBe(final.contentDigest);
  });

  it('supersedes a leftover draft with files and discards an empty one', () => {
    const { versions, execution } = setup();
    expect(versions.supersedeDraft(execution.id)).toBeUndefined();
    const empty = versions.openDraft(execution.id, 1);
    expect(versions.supersedeDraft(execution.id)).toBeUndefined();
    expect(versions.getById(empty.id)).toBeUndefined();
    const draft = versions.openDraft(execution.id, 1);
    versions.putFile(draft.id, { path: 'main.py', role: 'script', content: 'a' });
    expect(versions.supersedeDraft(execution.id)).toMatchObject({ status: 'superseded', contentDigest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(versions.findDraft(execution.id)).toBeUndefined();
  });

  it('allocates attempt numbers past everything either table has used, and renumbers only a draft', () => {
    const { versions, attempts, execution } = setup();
    expect(versions.nextAttemptNumber(execution.id)).toBe(1);
    attempts.refuse({ executionId: execution.id, attempt: 1, callId: null, reason: 'runtime_unavailable' });
    expect(versions.nextAttemptNumber(execution.id)).toBe(2);
    const draft = versions.openDraft(execution.id, 2);
    expect(versions.nextAttemptNumber(execution.id)).toBe(3);
    expect(versions.renumberDraft(draft.id, 5)).toMatchObject({ attempt: 5, dirPath: `scripts/${execution.id}/attempt-5` });
    versions.putFile(draft.id, { path: 'main.py', role: 'script', content: 'a' });
    versions.seal(draft.id);
    expect(() => versions.renumberDraft(draft.id, 6)).toThrow(CodeVersionImmutableError);
  });

  it('lists versions newest attempt first with their files', () => {
    const { versions, execution } = setup();
    for (const attempt of [1, 2]) {
      const draft = versions.openDraft(execution.id, attempt);
      versions.putFile(draft.id, { path: 'main.py', role: 'script', content: `v${attempt}` });
      versions.seal(draft.id);
    }
    const listed = versions.listByExecution(execution.id);
    expect(listed.map(({ attempt }) => attempt)).toEqual([2, 1]);
    expect(listed.map(({ files }) => files[0]!.content)).toEqual(['v2', 'v1']);
  });
});

describe('GenerationAttemptRepository', () => {
  function sealed(context: ReturnType<typeof setup>, attempt: number) {
    const draft = context.versions.openDraft(context.execution.id, attempt);
    context.versions.putFile(draft.id, { path: 'main.py', role: 'script', content: `v${attempt}` });
    return context.versions.seal(draft.id);
  }

  it('counts settled attempts and ignores refusals', () => {
    const context = setup();
    const { attempts, execution } = context;
    const first = attempts.open({ executionId: execution.id, codeVersionId: sealed(context, 1).id, attempt: 1, callId: 'call-1' });
    attempts.settle(first.id, { status: 'failed', testsTotal: 3, testsPassed: 2, testsFailed: 1, exitCode: 1, manifestPresent: false, diagnosticDigest: 'd'.repeat(64), droppedLineCount: 4, durationMs: 50 });
    const second = attempts.open({ executionId: execution.id, codeVersionId: sealed(context, 2).id, attempt: 2, callId: 'call-2' });
    attempts.settle(second.id, { status: 'passed', testsTotal: 3, testsPassed: 3, testsFailed: 0, exitCode: 0, manifestPresent: true });
    attempts.refuse({ executionId: execution.id, attempt: 3, callId: 'call-3', reason: 'attempt_limit' });
    expect(attempts.countUsed(execution.id)).toBe(2);
    expect(attempts.listByExecution(execution.id).map(({ status }) => status)).toEqual(['failed', 'passed', 'refused']);
    expect(attempts.getByCallId('call-3')).toMatchObject({ refusalReason: 'attempt_limit', codeVersionId: null, settledAt: expect.any(Date) });
    expect(() => attempts.settle(first.id, { status: 'passed' })).toThrow(/already settled/);
  });

  it('rejects duplicate attempt numbers, duplicate call ids, a second run of one version, and attempt 0', () => {
    const context = setup();
    const { attempts, execution, connection } = context;
    const version = sealed(context, 1);
    attempts.open({ executionId: execution.id, codeVersionId: version.id, attempt: 1, callId: 'call-1' });
    expect(() => attempts.refuse({ executionId: execution.id, attempt: 1, callId: null, reason: 'time_limit' })).toThrow();
    expect(() => attempts.refuse({ executionId: execution.id, attempt: 2, callId: 'call-1', reason: 'time_limit' })).toThrow();
    expect(() => attempts.open({ executionId: execution.id, codeVersionId: version.id, attempt: 2, callId: 'call-2' })).toThrow();
    attempts.refuse({ executionId: execution.id, attempt: 2, callId: null, reason: 'time_limit' });
    attempts.refuse({ executionId: execution.id, attempt: 3, callId: null, reason: 'cost_limit' });
    expect(() => attempts.refuse({ executionId: execution.id, attempt: 0 as number, callId: null, reason: 'cost_limit' })).toThrow();
    expect(() => connection.client.prepare("INSERT INTO generation_attempt (execution_id, attempt, status, refusal_reason) VALUES (?, 9, 'failed', 'attempt_limit')").run(execution.id)).toThrow(/CHECK/);
    expect(() => connection.client.prepare("INSERT INTO generation_attempt (execution_id, attempt, status) VALUES (?, 9, 'refused')").run(execution.id)).toThrow(/CHECK/);
  });

  it('aborts attempts a crash left running', () => {
    const context = setup();
    const row = context.attempts.open({ executionId: context.execution.id, codeVersionId: sealed(context, 1).id, attempt: 1, callId: null });
    expect(context.attempts.abortRunning(context.execution.id)).toBe(1);
    expect(context.attempts.listByExecution(context.execution.id)[0]).toMatchObject({ id: row.id, status: 'aborted' });
    expect(context.attempts.countUsed(context.execution.id)).toBe(1);
  });
});

describe('execution retries and cascades', () => {
  function withUpload(context: ReturnType<typeof setup>) {
    return context.uploads.createStaged({ originalFilename: 'sales.csv', storedFilename: '1-sales.csv', filePath: 'uploads/1/1-sales.csv', format: 'csv', mimeType: 'text/csv', byteSize: 10, sha256: 'f'.repeat(64) });
  }

  it('creates a retry linked to its source without touching the source, and survives the source being deleted', () => {
    const context = setup();
    const { executions, execution, connection } = context;
    const before = executions.getById(execution.id);
    const retry = executions.createRetry(execution.id, 'Group by month.');
    expect(retry).toMatchObject({ taskId: execution.taskId, trigger: 'rerun', retryOfExecutionId: execution.id, guidance: 'Group by month.', status: 'pending' });
    expect(executions.getById(execution.id)).toEqual(before);
    const again = executions.createRetry(retry.id, null);
    expect(executions.getRetryChain(again.id).map(({ id }) => id)).toEqual([execution.id, retry.id, again.id]);
    connection.client.prepare('DELETE FROM execution WHERE id = ?').run(execution.id);
    expect(executions.getById(retry.id)).toMatchObject({ retryOfExecutionId: null });
    expect(executions.getRetryChain(again.id).map(({ id }) => id)).toEqual([retry.id, again.id]);
    expect(() => executions.createRetry(9999, null)).toThrow();
  });

  it('cascades a deleted execution to versions, files, attempts, and fixtures, leaving no orphans', () => {
    const context = setup();
    const { versions, attempts, fixtures, execution, connection } = context;
    const upload = withUpload(context);
    const draft = versions.openDraft(execution.id, 1);
    versions.putFile(draft.id, { path: 'main.py', role: 'script', content: 'a' });
    versions.putFile(draft.id, { path: 'test_main.py', role: 'test', content: 'def test_a():\n    pass\n' });
    versions.seal(draft.id);
    attempts.open({ executionId: execution.id, codeVersionId: draft.id, attempt: 1, callId: 'c' });
    fixtures.record(execution.id, { uploadId: upload.id, filePath: `scripts/${execution.id}/fixtures/1-sales.csv`, format: 'csv', sheetCount: 1, rowCount: 200, sampleRowCount: 10, byteSize: 100, sha256: 'e'.repeat(64), seed: 'abc' });
    expect(() => fixtures.record(execution.id, { uploadId: upload.id, filePath: 'x', format: 'csv', sheetCount: 1, rowCount: 1, sampleRowCount: 0, byteSize: 1, sha256: 'e'.repeat(64), seed: 'x' })).toThrow();
    expect([count(connection, 'code_version'), count(connection, 'code_file'), count(connection, 'generation_attempt'), count(connection, 'synthetic_fixture')]).toEqual([1, 2, 1, 1]);
    connection.client.prepare('DELETE FROM execution WHERE id = ?').run(execution.id);
    expect([count(connection, 'code_version'), count(connection, 'code_file'), count(connection, 'generation_attempt'), count(connection, 'synthetic_fixture')]).toEqual([0, 0, 0, 0]);
    expect(connection.client.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('replaces an execution\'s fixture rows atomically', () => {
    const context = setup();
    const upload = withUpload(context);
    const row = { uploadId: upload.id, filePath: 'scripts/1/fixtures/1-sales.csv', format: 'csv' as const, sheetCount: 1, rowCount: 200, sampleRowCount: 10, byteSize: 100, sha256: 'e'.repeat(64), seed: 'abc' };
    context.fixtures.replaceForExecution(context.execution.id, [row]);
    const replaced = context.fixtures.replaceForExecution(context.execution.id, [{ ...row, byteSize: 101 }]);
    expect(context.fixtures.listByExecution(context.execution.id)).toEqual(replaced);
    expect(replaced).toHaveLength(1);
    expect(replaced[0]!.byteSize).toBe(101);
  });
});
